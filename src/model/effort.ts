// ── AUTO-EFFORT ROUTING (pure) ───────────────────────────────────────────────
// Reasoning effort (low … xhigh/max) is a real per-model control (the vocab
// lives on ModelSpec.efforts, pulled from each provider's docs — NOT fabricated).
// This module decides WHICH effort to run a (model, task) at, by minimizing the
// SAME expected-cost objective the model router uses: low effort for easy/netted
// work (cheaper + faster, and the quality is already enough), high effort for
// hard/unnetted work (the extra quality is worth the cost + latency).
//
// PROVENANCE — what is real vs modeled (the user's "don't fabricate" rule):
//   - cost effect: REAL. Reasoning effort is spent as output/thinking tokens
//     billed at the output rate; more effort ⇒ more output tokens. The exact
//     multiplier per level is a calibrated estimate, but the mechanism and
//     direction are not invented.
//   - latency effect: REAL in direction. More thinking ⇒ slower first token and
//     more generated tokens (measured: GPT-5.5 xhigh TTFT ~80s vs seconds at low).
//   - quality effect: MODELED, not researched. No provider publishes a per-effort
//     quality breakdown, so this is a SMALL, conservative, monotonic estimate
//     (|Δ| ≤ 0.1 — effort tunes a model, it never turns a weak one into a strong
//     one), tagged `estimated` and meant to be refined by the flywheel. It is
//     NOT presented as measured fact.
import { effectiveCost, type ObjectiveCandidate, type ObjectiveContext } from "./objective.ts";

export const EFFORT_QUALITY_PROVENANCE = "estimated" as const;

// Canonical weakest→strongest order (mirrors reasoning.ts EFFORT_ORDER).
const ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface EffortEffect {
  // Multiplier on the model's BASE output factor (calibrated for its default
  // effort). Reasoning tokens scale steeply at high effort.
  outputFactorMult: number;
  // Multiplier on time-to-first-token (more thinking before the first token).
  ttftMult: number;
  // How much of effort's potential quality help this level delivers, 0..1
  // (none → 0, max → 1). The ACTUAL quality gain is this × the task's difficulty
  // × EFFORT_QUALITY_MAX (see qualityGainFromEffort): effort helps a LOT on a
  // hard task and barely on an easy one — which is exactly what reasoning models
  // are for. Modeled (no public per-effort quality data), conservative, bounded.
  reasoningCurve: number;
}

// One table, indexed by level. Directions are grounded; magnitudes are calibrated
// estimates (cost/latency) and a conservative modeled curve (reasoningCurve).
const EFFECTS: Record<string, EffortEffect> = {
  none:    { outputFactorMult: 0.3, ttftMult: 0.5, reasoningCurve: 0.0 },
  minimal: { outputFactorMult: 0.5, ttftMult: 0.7, reasoningCurve: 0.15 },
  low:     { outputFactorMult: 0.7, ttftMult: 0.8, reasoningCurve: 0.35 },
  medium:  { outputFactorMult: 1.0, ttftMult: 1.0, reasoningCurve: 0.6 },
  high:    { outputFactorMult: 1.5, ttftMult: 1.3, reasoningCurve: 0.8 },
  xhigh:   { outputFactorMult: 2.4, ttftMult: 2.4, reasoningCurve: 0.93 },
  max:     { outputFactorMult: 3.2, ttftMult: 3.5, reasoningCurve: 1.0 },
};
const NEUTRAL: EffortEffect = { outputFactorMult: 1, ttftMult: 1, reasoningCurve: 0.6 };

// Most quality (in P(success) points) full effort can add on a MAXIMALLY hard
// task, vs no effort. Conservative + modeled (effort tunes, never transforms):
// on an easy task (difficulty 0) effort adds ~nothing; on the hardest it can add
// up to this. Calibratable by the flywheel.
export const EFFORT_QUALITY_MAX = 0.15;

export function effortEffect(level: string): EffortEffect {
  return EFFECTS[level] ?? NEUTRAL;
}

/** Quality the chosen effort adds for a task of this difficulty (0..1). The
 *  effort×difficulty interaction: effort helps proportional to how hard the task
 *  is. Modeled, not measured. */
export function qualityGainFromEffort(level: string, difficulty: number): number {
  return effortEffect(level).reasoningCurve * Math.max(0, Math.min(1, difficulty)) * EFFORT_QUALITY_MAX;
}

// The model facts the effort search needs (account-independent — account
// economics are constant across a model's effort levels, so they don't affect
// WHICH effort is best for that model).
export interface EffortModel {
  quality: number; // the model's base (real benchmark) quality for the kind
  inUSDPerMtok: number;
  outUSDPerMtok: number;
  tps: number;
  ttftMs: number;
  baseOutputFactor: number; // the model's default output factor (profiles.outputFactorFor)
}

export interface EffortPick {
  level: string | undefined; // undefined when the model has no effort vocabulary
  outputFactor: number; // the effort-adjusted output factor (for the cost/latency terms)
  quality: number; // the effort-adjusted quality (for P(wrong))
  ttftMs: number; // the effort-adjusted TTFT
}

/**
 * Pick the effort level minimizing expected cost-to-correct for this (model,
 * task). Returns the level plus the effort-adjusted (quality, outputFactor,
 * ttft) so the caller can score the model at its best effort. Empty vocab →
 * level undefined and the model's base numbers unchanged.
 */
export function bestEffort(model: EffortModel, levels: string[], ctx: ObjectiveContext): EffortPick {
  if (!levels.length) {
    return { level: undefined, outputFactor: model.baseOutputFactor, quality: model.quality, ttftMs: model.ttftMs };
  }
  // Evaluate each level through the objective; keep the cheapest.
  const ordered = levels.slice().sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  const qualityAt = (level: string) => clamp01(model.quality + qualityGainFromEffort(level, ctx.difficulty));
  let best: { level: string; cost: number; e: EffortEffect } | undefined;
  for (const level of ordered) {
    const e = effortEffect(level);
    const cand: ObjectiveCandidate = {
      inUSDPerMtok: model.inUSDPerMtok,
      outUSDPerMtok: model.outUSDPerMtok,
      quality: qualityAt(level),
      tps: model.tps,
      ttftMs: model.ttftMs * e.ttftMult,
      outputFactor: model.baseOutputFactor * e.outputFactorMult,
    };
    const cost = effectiveCost(cand, ctx).total;
    if (!best || cost < best.cost) best = { level, cost, e };
  }
  const e = best!.e;
  return {
    level: best!.level,
    outputFactor: model.baseOutputFactor * e.outputFactorMult,
    quality: qualityAt(best!.level),
    ttftMs: model.ttftMs * e.ttftMult,
  };
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
