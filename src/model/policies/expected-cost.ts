// expected-cost policy — minimize expected cost-to-verified-green instead of
// clearing a static bar. Where a verifier exists (Task.verifierTier), a cheap
// model is routed FIRST whenever its expected total cost — its own attempt,
// plus the chance of a miss times the fix iterations and the strong-model
// rescue — beats sending the strong model directly:
//
//   E[cheap] = c_cheap · (1 + p_fail · FIX_OVERHEAD) + p_fail · c_strong  <  c_strong
//
// A miss is caught by the same VERIFY gate that exists today and escalates
// through the same path, so reliability is unchanged where tests exist. Where
// NO verifier exists a miss is invisible, so the bar is RAISED above the
// baseline instead — caution scales with verifier strength in both directions.
import { RoutingSelector, BAR_MAX, type Candidate } from "../router.ts";
import { pickBest } from "../scoring.ts";
import { toScoreCandidate } from "../router.ts";
import type { Task, ModelChoice } from "../selector.ts";
import { costEstOf, adjQualityOf, pFailOf } from "./util.ts";

type Kind = NonNullable<Task["kind"]>;

// A failed cheap attempt costs roughly half a turn again in fix iterations
// before the rescue model takes over (measured loops are 1–2 short attempts).
const FIX_OVERHEAD = 0.5;
// A types-only verifier (typecheck/build/lint, no tests) misses semantic bugs,
// so the cheap model's failure probability is inflated before the comparison.
const TYPES_INFLATE = 1.6;
// Don't draft with anything below Haiku/Flash class even when the math says
// so — sub-0.3 models produce edits that fail in ways fix loops can't recover.
const CHEAP_FLOOR = 0.3;

// The shape of RoutingSelector.prepare()'s result that the expected-cost core
// needs. Declared structurally so combined.ts can reuse the same core.
export interface PreparedPool {
  kind: Kind;
  bar: number;
  escalate: number;
  ctx: { now: number };
  pool: Candidate[];
  clears: Candidate[];
  estInputTokens: number;
}

/** The expected-cost core: given the prepared pool and the baseline (strong)
 *  winner, return the candidate with the lowest expected cost-to-green, or
 *  null when the strong direct pick already wins (defer to baseline).
 *  `extraDelta` lets the combined policy fold precedent into quality. */
export function expectedCostPick(
  p: PreparedPool,
  task: Task,
  extraDelta: (c: Candidate) => number = () => 0,
): { c: Candidate; e: number; cStrong: number; pf: number } | null {
  const tier = task.verifierTier ?? "none";
  if (tier === "none" || !p.clears.length) return null;
  // The strong reference = what the baseline would send (cheapest bar-clearer
  // by the live scorer). If it's a subscription seat its marginal cost is ~$0
  // and nothing can beat free — defer.
  const best = pickBest({ candidates: p.clears.map((c) => toScoreCandidate(c, p.kind)), now: p.ctx.now, estInputTokens: p.estInputTokens, interactive: task.interactive });
  const strong = p.clears.find((c) => c.spec.id === best.candidate.id)!;
  if (strong.backend.kind === "cli") return null;
  const cStrong = costEstOf(strong, p.estInputTokens);
  const inflate = tier === "tests" ? 1 : TYPES_INFLATE;

  let winner: { c: Candidate; e: number; pf: number } = { c: strong, e: cStrong, pf: 0 };
  for (const c of p.pool) {
    if (c.spec.id === strong.spec.id) continue;
    if (c.backend.kind === "cli") continue; // seat pricing is fictional; seats win via the baseline path
    if (adjQualityOf(p.kind, c) + extraDelta(c) < CHEAP_FLOOR) continue;
    const cc = costEstOf(c, p.estInputTokens);
    if (cc >= cStrong) continue; // only a genuinely cheaper draft can pay for its risk
    const pf = Math.min(0.95, pFailOf(p.kind, c) * inflate);
    const e = cc * (1 + pf * FIX_OVERHEAD) + pf * cStrong;
    if (e < winner.e - 1e-9) winner = { c, e, pf };
  }
  return winner.c.spec.id === strong.spec.id ? null : { ...winner, cStrong };
}

export class ExpectedCostSelector extends RoutingSelector {
  override readonly policyName: string = "expected-cost";

  protected override barFor(kind: Kind, escalate: number, task: Task): number {
    const base = super.barFor(kind, escalate, task);
    // No verifier → a miss is invisible → demand more quality up front. The
    // baseline is exactly as cautious in a fully-tested repo as in one with
    // no checks at all; this is the other half of fixing that.
    if ((task.verifierTier ?? "none") === "none" && (kind === "code" || kind === "plan") && escalate === 0) {
      return Math.min(BAR_MAX, base + 0.1);
    }
    return base;
  }

  override select(task: Task): ModelChoice {
    // Escalations climb through the baseline path (the cheap draft already
    // missed); bounded sub-tasks are already routed cheapest by the baseline.
    if ((task.escalate ?? 0) > 0) return super.select(task);
    const p = this.prepare(task);
    if (!p.pool.length || (p.kind !== "code" && p.kind !== "plan")) return super.select(task);
    if (this.preferredIn(p.kind, p.pool)) return super.select(task); // /prefer beats the math
    const pick = expectedCostPick(p, task);
    if (!pick) return super.select(task);
    const choice: ModelChoice = {
      model: pick.c.spec,
      reason: `${p.kind} · expected-cost: $${pick.e.toFixed(3)} est vs $${pick.cStrong.toFixed(3)} direct (p_fail ${Math.round(pick.pf * 100)}%, verifier: ${task.verifierTier})`,
      backend: pick.c.backend,
    };
    this.logDecision(task, p.kind, p.bar, p.escalate, choice, p.pool, p);
    return choice;
  }
}
