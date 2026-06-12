// Precedent — route by nearest verified neighbor. The priors flywheel
// aggregates per (kind, model); this module answers the finer question "how
// did THIS model do on tasks that LOOKED LIKE this one, in this repo?" using
// the routing-outcome log (outcomes.ts) and plain term-set similarity over the
// same BM25 tokens retrieval uses. No embeddings, no model calls: "the last
// five tasks that looked like this passed on deepseek here" beats any static
// benchmark number. The kNN math is pure given rows, so it is fixture-tested
// directly (test/precedent.test.ts).
import { readRoutingOutcomes, type RoutingOutcome } from "./outcomes.ts";

export interface PrecedentStats {
  n: number; // neighbors considered
  meanSim: number; // average similarity of those neighbors (0..1)
  passRate: number; // similarity-weighted, Laplace-smoothed
  delta: number; // quality adjustment, clamped [-0.15, +0.15]
}

const K = 8; // nearest neighbors per (model, kind)
const MIN_SIM = 0.12; // below this, "similar" is noise
const MIN_K = 3; // fewer than 3 neighbors is anecdote, not precedent
const BASELINE = 0.8; // same expected pass rate the priors use
const SCALE = 0.3;
const MAX_ABS_DELTA = 0.15; // strong local precedent can cross a bar either way

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Jaccard similarity between two term lists. */
export function termSimilarity(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const t of sb) if (sa.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** Pure core: precedent stats for one model from candidate outcome rows.
 *  Exported separately from the file-reading wrapper so tests feed fixtures. */
export function precedentFromRows(promptTerms: string[], rows: RoutingOutcome[]): PrecedentStats | null {
  const scored = rows
    .filter((r) => r.outcome !== "unverified")
    .map((r) => ({ r, sim: termSimilarity(promptTerms, r.terms) }))
    .filter((x) => x.sim >= MIN_SIM)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, K);
  if (scored.length < MIN_K) return null;
  // Similarity-weighted outcomes: a near-identical past task counts more than a
  // marginal match. /undo keeps its double weight (a human revert is the
  // costliest outcome). Laplace smoothing avoids 0%/100% extremes.
  let wp = 0;
  let wf = 0;
  for (const { r, sim } of scored) {
    if (r.outcome === "passed") wp += sim;
    else wf += sim * (r.outcome === "undone" ? 2 : 1);
  }
  const passRate = (wp + 1) / (wp + wf + 2);
  const delta = clamp((passRate - BASELINE) * SCALE, -MAX_ABS_DELTA, MAX_ABS_DELTA);
  const meanSim = scored.reduce((s, x) => s + x.sim, 0) / scored.length;
  return { n: scored.length, meanSim, passRate, delta };
}

/** Precedent stats for (kind, model) against this repo's outcome log, or null
 *  when there isn't enough similar history to speak. */
export function precedentFor(promptTerms: string[], kind: string, modelId: string, repo?: string): PrecedentStats | null {
  const rows = readRoutingOutcomes(repo).filter((r) => r.kind === kind && r.modelId === modelId);
  return precedentFromRows(promptTerms, rows);
}

/** Human line for /why and reasons: "precedent here: 6 similar · 83% ✓". */
export function precedentLine(stats: PrecedentStats): string {
  return `precedent here: ${stats.n} similar · ${Math.round(stats.passRate * 100)}% ✓`;
}
