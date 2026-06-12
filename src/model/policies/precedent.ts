// precedent policy — route by nearest verified neighbor. Replaces the coarse
// (kind, model) prior with "how did each model do on tasks that LOOKED LIKE
// this one, here" (src/model/precedent.ts: kNN over the routing-outcome log by
// BM25 term similarity). Strong local precedent moves effective quality up to
// ±0.15 — enough for a cheap model with a green local record to cross the bar,
// or a benchmark darling that keeps failing here to sink below it.
import { RoutingSelector, toScoreCandidate, hasKnownQuality, type Candidate } from "../router.ts";
import { pickBest } from "../scoring.ts";
import { terms } from "../../context/retrieve.ts";
import { precedentFor, precedentLine, type PrecedentStats } from "../precedent.ts";
import type { Task, ModelChoice } from "../selector.ts";
import { adjQualityOf } from "./util.ts";

export class PrecedentSelector extends RoutingSelector {
  override readonly policyName: string = "precedent";

  override select(task: Task): ModelChoice {
    const p = this.prepare(task);
    if (!p.pool.length) return super.select(task);
    if (this.preferredIn(p.kind, p.pool)) return super.select(task);

    const promptTerms = terms(task.prompt);
    const statsOf = new Map<string, PrecedentStats | null>();
    const stats = (c: Candidate) => {
      const id = c.canonicalId ?? c.spec.id;
      if (!statsOf.has(id)) statsOf.set(id, precedentFor(promptTerms, p.kind, id));
      return statsOf.get(id) ?? null;
    };
    // Re-derive the bar-clearing set with precedent folded into quality. Same
    // shape as the base clearsAdj: a seat with no benchmark clears on benefit
    // of the doubt.
    const adj = (c: Candidate) => adjQualityOf(p.kind, c) + (stats(c)?.delta ?? 0);
    const clears = p.pool.filter((c) => (c.backend.kind === "cli" ? !hasKnownQuality(c) || adj(c) >= p.bar : adj(c) >= p.bar));
    if (!clears.length) return super.select(task); // no precedent-cleared candidate → baseline fallback path

    const best = pickBest({ candidates: clears.map((c) => toScoreCandidate(c, p.kind)), now: p.ctx.now, estInputTokens: p.estInputTokens, interactive: task.interactive });
    const winner = clears.find((c) => c.spec.id === best.candidate.id)!;
    const ws = stats(winner);
    const choice: ModelChoice = {
      model: winner.spec,
      reason: `${p.kind} · ${ws ? precedentLine(ws) : "no similar history yet — baseline pick"}`,
      backend: winner.backend,
    };
    this.logDecision(task, p.kind, p.bar, p.escalate, choice, clears, p);
    return choice;
  }
}
