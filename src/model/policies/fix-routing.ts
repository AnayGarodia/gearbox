// fix-routing policy — route the FIX, not just the task. The baseline raises
// the bar +0.08 per failed check regardless of WHAT failed, which often
// re-selects the same model (0.77 clears a 0.78 bar) and thrashes. But the
// failure kind is known (verify.ts checkIntent): a typecheck/lint/build
// failure means a compiler already pinpointed the error — a much EASIER task
// than the original edit, so it routes DOWN to a cheap model; a test failure
// signals a reasoning miss, so it jumps STRAIGHT to the strongest tier instead
// of climbing in +0.08 steps.
import { RoutingSelector, toScoreCandidate } from "../router.ts";
import { pickBest } from "../scoring.ts";
import type { Task, ModelChoice } from "../selector.ts";
import { adjQualityOf, strongestOf } from "./util.ts";

// Mechanical fixes still need a competent model — Haiku/Flash class, not the
// sub-0.3 tier whose edits create new failures faster than they fix old ones.
const MECHANICAL_FLOOR = 0.3;

export class FixRoutingSelector extends RoutingSelector {
  override readonly policyName: string = "fix-routing";

  override select(task: Task): ModelChoice {
    if ((task.escalate ?? 0) <= 0) return super.select(task);
    const p = this.prepare(task);
    if (!p.pool.length) return super.select(task);
    const fk = task.failureKind ?? "other";

    if (fk === "typecheck" || fk === "lint" || fk === "build") {
      // Mechanical failure: the error message names the file and line. The
      // cheapest competent candidate wins (scored, so seat/scarcity/throttle
      // signals still apply).
      const competent = p.pool.filter((c) => adjQualityOf(p.kind, c) >= MECHANICAL_FLOOR);
      const from = competent.length ? competent : p.pool;
      const best = pickBest({ candidates: from.map((c) => toScoreCandidate(c, p.kind)), now: p.ctx.now, estInputTokens: p.estInputTokens, interactive: task.interactive });
      const w = from.find((c) => c.spec.id === best.candidate.id)!;
      const choice: ModelChoice = { model: w.spec, reason: `${p.kind} · ${fk} failed → routed down (mechanical fix, compiler pinpointed it)`, backend: w.backend };
      this.logDecision(task, p.kind, p.bar, p.escalate, choice, from, p);
      return choice;
    }

    // Semantic miss (test failure, or unclassifiable): straight to the top —
    // ending a 3-iteration thrash loop one hop early is cheaper AND greener
    // than climbing +0.08 at a time.
    const top = strongestOf(p.pool, p.kind, p.estInputTokens)!;
    const choice: ModelChoice = { model: top.spec, reason: `${p.kind} · ${fk} failed → strongest tier (semantic miss, no +0.08 thrash)`, backend: top.backend };
    this.logDecision(task, p.kind, p.bar, p.escalate, choice, p.pool, p);
    return choice;
  }
}
