// ── THE EXPECTED-COST-TO-CORRECT OBJECTIVE (pure) ────────────────────────────
// Routing's selection rule. There is NO arbitrary quality bar (the old 0.7 was
// reverse-engineered to fit seeded guesses, a noise-width cliff, and conflated
// "absolute quality" with "good enough for THIS task"). Instead every candidate
// is scored by its expected cost to reach a CORRECT result, in ONE currency
// (dollars) that simultaneously optimizes the three things that actually matter:
//
//   E[total] = dollars(attempt)                              ← COST
//            + expected_seconds × value_of_a_second          ← LATENCY
//            + P(wrong) × cost_of_wrong                       ← QUALITY
//
// The router picks argmin(E[total]). The "threshold" is emergent: a cheap model
// wins easy/verifier-netted work because its expected cost is genuinely lowest;
// a strong model wins hard/unnetted work because a likely miss is genuinely
// expensive. The same objective absorbs difficulty (raises P(wrong)), the
// verifier tier (sets cost_of_wrong), the measured per-repo flywheel (raises
// P(wrong)), interactivity (sets value_of_a_second), and EFFORT — the caller
// enumerates (model × account × effort) variants and each carries its own
// quality / latency / token cost, so "sonnet:low vs sonnet:xhigh" falls out of
// the same argmin.
//
// PURE: no I/O, no Date.now. Every input arrives as an argument, so it is fully
// fixture-testable and deterministic. The only constants are INTERPRETABLE and
// bake-off-calibratable (retries per miss, ship-wrong penalty, value of a
// second) — not magic quality cutoffs.

export interface ObjectiveCandidate {
  inUSDPerMtok: number;
  outUSDPerMtok: number;
  // Real per-kind quality, 0..1 (benchmarks.ts), already prior-adjusted by the
  // caller if a measured delta exists. Drives P(wrong).
  quality: number;
  tps: number; // output tokens/sec (0 = unknown → treated as mid-speed)
  ttftMs: number; // time to first token in ms (0 = unknown → small default)
  outputFactor: number; // expected output tokens as a fraction of input (effort raises this)
}

export interface ObjectiveContext {
  estInputTokens: number;
  difficulty: number; // 0..1 task difficulty WITHIN the kind (raises P(wrong) for weak models)
  verifierTier: "tests" | "types" | "none"; // sets cost_of_wrong (a caught miss is cheap; a shipped one is not)
  interactive: boolean; // true when the user is waiting → value_of_a_second is high
  repoFailRate?: number; // measured per-repo fail rate for this (kind, model) — the flywheel
  weights?: ObjectiveWeights;
}

export interface ObjectiveWeights {
  escalationUSD: number; // recovery cost of a CAUGHT miss (rerun/escalate to a capable model)
  recoverySeconds: number; // recovery wall-clock of a caught miss (charged at vTime when interactive)
  shipWrongUSD: number; // damage of a SILENTLY-shipped wrong result (no verifier to catch it)
  vTimeInteractiveUSDPerSec: number; // $ value of a second while the user waits
  vTimeBackgroundUSDPerSec: number; // $ value of a second for background/delegated work (~0)
  difficultyToFailure: number; // how much difficulty inflates P(wrong)
}

// Defaults are INTERPRETABLE (not arbitrary cutoffs) and are what a bake-off
// tunes. The cost of a wrong result is a RECOVERY cost, independent of which
// model erred — so quality lowers it only through P(wrong), never by charging an
// expensive model more for missing.
//   escalationUSD: a caught miss costs ~$0.10 to rerun/escalate.
//   shipWrongUSD: a silently-shipped wrong result with no test net is worth ~$2
//     of extra model spend to avoid (deliberately high — a hidden bug costs far
//     more than a few cents of tokens; this is what makes "no net → be cautious"
//     emerge instead of being a magic +0.1).
//   vTime interactive ~$0.02/s ≈ $72/hr of attention; background ~0.
export const DEFAULT_OBJECTIVE_WEIGHTS: ObjectiveWeights = {
  escalationUSD: 0.1,
  recoverySeconds: 8,
  shipWrongUSD: 2.0,
  vTimeInteractiveUSDPerSec: 0.02,
  vTimeBackgroundUSDPerSec: 0.001,
  difficultyToFailure: 0.5,
};

const TPS_REF_UNKNOWN = 80; // tps=0 (unknown) → assume mid-speed, never punish missing data
const TTFT_UNKNOWN_MS = 1500;

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export interface ObjectiveResult {
  total: number; // the number minimized (lower is better)
  dollars: number; // raw attempt price
  latencyCost: number; // expected_seconds × value_of_a_second
  wrongCost: number; // P(wrong) × cost_of_wrong
  pWrong: number; // exposed for /why
  seconds: number; // expected wall-clock for the attempt
}

/** Dollars for one attempt at this candidate's token budget. */
function attemptDollars(c: ObjectiveCandidate, inTok: number): number {
  const outTok = c.outputFactor * inTok;
  return (inTok / 1e6) * c.inUSDPerMtok + (outTok / 1e6) * c.outUSDPerMtok;
}

/** Expected wall-clock seconds: time-to-first-token + generation of the output. */
function attemptSeconds(c: ObjectiveCandidate, inTok: number): number {
  const ttft = (c.ttftMs > 0 ? c.ttftMs : TTFT_UNKNOWN_MS) / 1000;
  const tps = c.tps > 0 ? c.tps : TPS_REF_UNKNOWN;
  const outTok = c.outputFactor * inTok;
  return ttft + outTok / tps;
}

/**
 * P(the attempt produces a wrong/insufficient result). Grounded in real quality
 * (1 − quality is the base miss rate), inflated by task difficulty (a hard task
 * is likelier to defeat a given quality level), and — when a measured per-repo
 * fail rate exists — blended toward that hard evidence. Clamped to [0,1].
 */
function pWrong(c: ObjectiveCandidate, x: ObjectiveContext, w: ObjectiveWeights): number {
  const base = clamp01(1 - c.quality);
  const withDifficulty = clamp01(base + x.difficulty * w.difficultyToFailure * base);
  // A measured repo fail rate is direct evidence — average it in (equal weight)
  // so the flywheel pulls the estimate toward observed reality without erasing
  // the benchmark prior.
  if (x.repoFailRate !== undefined) return clamp01((withDifficulty + x.repoFailRate) / 2);
  return withDifficulty;
}

/** The expected cost to a CORRECT result for one candidate, in dollars. */
export function effectiveCost(c: ObjectiveCandidate, x: ObjectiveContext): ObjectiveResult {
  const w = x.weights ?? DEFAULT_OBJECTIVE_WEIGHTS;
  const dollars = attemptDollars(c, x.estInputTokens);
  const seconds = attemptSeconds(c, x.estInputTokens);

  const vTime = x.interactive ? w.vTimeInteractiveUSDPerSec : w.vTimeBackgroundUSDPerSec;
  const latencyCost = seconds * vTime;

  const p = pWrong(c, x, w);
  // What a wrong result costs — a RECOVERY cost, the same whichever model erred
  // (so an expensive model is never charged MORE for missing; quality lowers
  // this only through P(wrong)):
  //   - a caught miss (a verifier exists): rerun/escalate → escalationUSD + the
  //     user's wait during recovery if interactive. Small ⇒ cheap-first is safe.
  //   - a silently-shipped miss (NO verifier): the ship-wrong damage, large ⇒
  //     quality dominates and a strong model wins. This is where "no net → be
  //     cautious" EMERGES instead of being a hand-set bar bump.
  const shipWrong = x.verifierTier === "none" ? w.shipWrongUSD : x.verifierTier === "types" ? w.shipWrongUSD * 0.4 : 0;
  const costOfWrong = w.escalationUSD + w.recoverySeconds * vTime + shipWrong;
  const wrongCost = p * costOfWrong;

  return { total: dollars + latencyCost + wrongCost, dollars, latencyCost, wrongCost, pWrong: p, seconds };
}
