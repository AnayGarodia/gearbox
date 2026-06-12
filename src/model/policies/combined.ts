// combined policy — the full stack: observables enrich the task (kind + bar
// from repo signals, no classify call), expected-cost decides cheap-first vs
// direct with precedent folded into quality, thompson probes a cheaper tier at
// the verifier-gated rate, and escalations route by failure kind (mechanical →
// down, semantic → top). The bench tells us whether this composition beats the
// best single policy or whether the pieces fight each other.
import { BAR_MAX, qualityOf, type Candidate } from "../router.ts";
import { countsFor } from "../priors.ts";
import { terms } from "../../context/retrieve.ts";
import { precedentFor } from "../precedent.ts";
import type { Task, ModelChoice } from "../selector.ts";
import { FixRoutingSelector } from "./fix-routing.ts";
import { expectedCostPick } from "./expected-cost.ts";
import { enrichWithObservables, difficultyBar } from "./observables.ts";
import { adjQualityOf, costEstOf, sampleBeta } from "./util.ts";

type Kind = NonNullable<Task["kind"]>;

const PROBE_FLOOR = 0.25;
const PROBE_MAX_COST = 0.8;
const SEED_N = 8;

// Extending FixRoutingSelector gives the escalate>0 path (failure-kind
// routing) via super.select; everything else overrides the escalate==0 path.
export class CombinedSelector extends FixRoutingSelector {
  override readonly policyName: string = "combined";
  readonly classifiesItself = true;
  private sinceProbe = 0;

  constructor(fallbackId?: string, private rng: () => number = Math.random) {
    super(fallbackId);
  }

  protected override barFor(kind: Kind, escalate: number, task: Task): number {
    let bar = super.barFor(kind, escalate, task);
    if (escalate > 0 || (kind !== "code" && kind !== "plan")) return bar;
    if (task.difficulty) bar = difficultyBar(bar, task.difficulty);
    if ((task.verifierTier ?? "none") === "none") bar = Math.min(BAR_MAX, bar + 0.1);
    return bar;
  }

  override select(task: Task): ModelChoice {
    const t = enrichWithObservables(task);
    if ((t.escalate ?? 0) > 0) return super.select(t); // failure-kind routing (FixRoutingSelector)
    const p = this.prepare(t);
    if (!p.pool.length || (p.kind !== "code" && p.kind !== "plan")) return super.select(t);
    if (this.preferredIn(p.kind, p.pool)) return super.select(t);

    // Precedent folds into quality for the expected-cost scan.
    const promptTerms = terms(t.prompt);
    const prec = (c: Candidate) => precedentFor(promptTerms, p.kind, c.canonicalId ?? c.spec.id)?.delta ?? 0;

    const pick = expectedCostPick(p, t, prec);
    let choice: ModelChoice;
    let logged: Candidate[] = p.pool;
    if (pick) {
      choice = {
        model: pick.c.spec,
        reason: `${p.kind} · expected-cost: $${pick.e.toFixed(3)} est vs $${pick.cStrong.toFixed(3)} direct (p_fail ${Math.round(pick.pf * 100)}%, verifier: ${t.verifierTier})`,
        backend: pick.c.backend,
      };
    } else {
      // Direct strong pick wins the math — but this is exactly where the
      // thompson probe earns its keep: occasionally test a cheaper tier so
      // the priors/precedent data that powers expected-cost keeps growing.
      const base = super.select(t); // RoutingSelector path via FixRoutingSelector (escalate==0)
      const probed = this.maybeProbe(t, p, base);
      if (probed) {
        choice = probed.choice;
        logged = probed.from;
      } else {
        return base; // already logged by the base path
      }
    }
    this.logDecision(t, p.kind, p.bar, p.escalate, choice, logged, p);
    return choice;
  }

  private maybeProbe(
    task: Task,
    p: { kind: Kind; pool: Candidate[]; estInputTokens: number },
    base: ModelChoice,
  ): { choice: ModelChoice; from: Candidate[] } | null {
    const tier = task.verifierTier ?? "none";
    const eps = tier === "tests" ? 0.15 : tier === "types" ? 0.05 : 0;
    if (eps === 0) return null;
    const baseCand = p.pool.find((c) => c.spec.id === base.model.id);
    if (!baseCand || baseCand.backend.kind === "cli") return null;
    this.sinceProbe++;
    if (this.sinceProbe < Math.round(1 / eps)) return null;
    const cBase = costEstOf(baseCand, p.estInputTokens);
    const probes = p.pool.filter(
      (c) =>
        c.spec.id !== base.model.id &&
        c.backend.kind !== "cli" &&
        adjQualityOf(p.kind, c) >= PROBE_FLOOR &&
        costEstOf(c, p.estInputTokens) < cBase * PROBE_MAX_COST,
    );
    if (!probes.length) return null;
    let pick: Candidate | null = null;
    let bestTheta = -1;
    for (const c of probes) {
      const counts = countsFor(p.kind, c.canonicalId ?? c.spec.id);
      const q = qualityOf(c);
      const theta = sampleBeta(
        (counts?.passed ?? 0) + q * SEED_N + 1,
        (counts ? counts.failed + 2 * counts.undone : 0) + (1 - q) * SEED_N + 1,
        this.rng,
      );
      if (theta > bestTheta) {
        bestTheta = theta;
        pick = c;
      }
    }
    if (!pick) return null;
    this.sinceProbe = 0;
    return {
      choice: { model: pick.spec, reason: `${p.kind} · probe (thompson): testing a cheaper tier under the ${tier} verifier`, backend: pick.backend },
      from: probes,
    };
  }
}
