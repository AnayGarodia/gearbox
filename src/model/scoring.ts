// ── PURE SCORING CORE ─────────────────────────────────────────────────────────
// This module ranks (model, account) candidates and returns the best pick. It is
// intentionally PURE: no I/O, no Date.now(), no store reads. Everything arrives
// via arguments, so the function is fully fixture-testable and deterministic
// (same inputs always produce the same pick).
//
// Score formula (lower is better):
//
//   score = costEst + scarcity + switchPenalty + limitPenalty + apiThrottlePenalty
//           - planBonus - latencyBonus
//
// Winner = argmin(score), tie-broken by: tps desc, quality desc, id asc.
// The tie-break is a total order, so the result is always deterministic.
//
// Design principles (per DESIGN.md):
//   - Every account-state term is ACTIVE only where the signal exists, and
//     NEUTRAL (0) when the signal is absent. Missing data is not penalised.
//   - A subscription seat is effectively free until its rate-limit window
//     empties (planBonus cancels costEst). As headroom falls below the knee it
//     ramps back toward full metered cost, so trivial work stops burning a
//     near-exhausted seat.
//   - Metered scarcity fires only where the provider exposes a live balance.
//     Stale balances (older than scarcityStaleMs) are ignored entirely.
//   - The latencyBonus is scaled by costEst, so a near-tie favors the snappier
//     model, but a clearly cheaper model still wins on cost.
import type { AccountState } from "./routing-context.ts";

// The minimal numeric view of a candidate the scorer needs. The router adapts
// a (ModelSpec, profile, AccountState) triple into this shape, keeping the
// scorer free of any dependency on the model registry or profile corpus.
export interface ScoreCandidate {
  id: string; // model id for tie-breaking and logging; subscription seats use cli:<account>:<sdkId>
  inUSDPerMtok: number;
  outUSDPerMtok: number;
  quality: number; // normalised 0..1; arrives prior-adjusted (router adds the per-repo measured delta)
  tps: number; // tokens per second, used for the latency-class tie-break
  account: AccountState; // the backing seat or API key
}

// Tunable weights. Defaults are calibrated to match the heuristic described in
// DESIGN.md. Pass a custom ScoreWeights in tests to isolate individual terms.
export interface ScoreWeights {
  wScarcity: number; // penalty multiplier for burning scarce metered credit
  wSwitch: number; // cache-miss surcharge as a fraction of this turn's estimated cost
  wPlan: number; // subscription plan bonus multiplier (subtracted from score)
  wLimit: number; // extra push away from a seat in the rate-limit red zone
  wApiThrottle: number; // push away from a metered key whose live RPM/TPM window is near-empty
  wLatency: number; // interactive only: pull faster models forward; 0 disables the term
  planHeadroomKnee: number; // headroom >= knee means the seat is treated as free; below this, ramps toward cost
  apiThrottleKnee: number; // API headroom >= knee is ignored as per-minute noise; below this, ramps
  scarcityStaleMs: number; // a balance snapshot older than this millisecond count is ignored
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  wScarcity: 1.0,
  wSwitch: 0.15,
  wPlan: 1.0,
  wLimit: 2.0,
  wApiThrottle: 0.5,
  wLatency: 0.5,
  planHeadroomKnee: 0.2,
  apiThrottleKnee: 0.15,
  scarcityStaleMs: 15 * 60_000,
};

// The reference tps at or above which a model is considered fully "fast"
// (approximately haiku-class at ~150 tok/s). Models with no latency data (tps 0)
// are treated as mid-speed (0.5) rather than assumed slow, so missing data is
// never punished.
const TPS_REF = 150;

// All inputs needed for a scoring run. Inject `now` (from Date.now()) so callers
// control the staleness check; this keeps the function deterministic in tests.
export interface ScoreInput {
  candidates: ScoreCandidate[];
  now: number; // wall-clock milliseconds, injected for determinism (staleness checks)
  weights?: ScoreWeights;
  estInputTokens: number; // calibrated working-set size for this turn
  estOutputTokens?: number; // defaults to 0.2 * input (agent turns are heavily input-dominated)
  warm?: { accountId: string; modelId: string }; // the currently loaded model, if any
  interactive?: boolean; // true when the user is waiting (foreground turn), false for background
}

// Per-term breakdown returned alongside the total score. Kept separate from the
// total so callers (scorecard UI, tests) can inspect individual contributions.
export interface ScoreTerms {
  costEst: number;
  scarcity: number;
  switchPenalty: number;
  limitPenalty: number;
  apiThrottlePenalty: number;
  planBonus: number; // subtracted in the score
  latencyBonus: number; // subtracted in the score (interactive: faster models get a higher bonus)
  meteredEquiv: number; // what a subscription pick would have cost at metered rates (informational)
}

export interface ScoredCandidate {
  candidate: ScoreCandidate;
  score: number; // lower is better
  costEst: number;
  terms: ScoreTerms;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

// Score a single candidate against a ScoreInput. Called per candidate by
// pickBest, and directly by the /why scorecard (which also scores below-bar
// candidates pickBest never sees). Ignores input.candidates — only `now`,
// weights, token estimates, and the warm/interactive flags are read. Returns
// the full breakdown so callers can display individual terms without
// re-running the math.
export function scoreCandidate(c: ScoreCandidate, input: ScoreInput): ScoredCandidate {
  const w = input.weights ?? DEFAULT_WEIGHTS;
  const inTok = input.estInputTokens;
  // Agent turns are input-heavy; default output is 20% of input tokens.
  const outTok = input.estOutputTokens ?? 0.2 * inTok;
  // Base cost estimate in USD for this turn's token budget.
  const costEst = (inTok / 1e6) * c.inUSDPerMtok + (outTok / 1e6) * c.outUSDPerMtok;
  const a = c.account;

  // Plan bonus: a flat-rate seat costs nothing marginal until its window empties.
  // Full bonus (= costEst * wPlan) while headroom >= knee, fading linearly to 0
  // as the binding window is exhausted. Unknown headroom assumes fresh (we
  // favor a seat we already pay for unless we know it is near its limit).
  let planBonus = 0;
  const meteredEquiv = costEst; // what this turn would cost at pay-per-token rates
  if (a.isSubscription) {
    const headroom = a.rateHeadroom ?? 1; // no snapshot means assume fresh
    const ramp = clamp(headroom / w.planHeadroomKnee, 0, 1);
    planBonus = w.wPlan * meteredEquiv * ramp;
  }

  // Scarcity: only fires where the provider exposes a live and fresh balance.
  // Grows as the estimated turn cost approaches the remaining balance (a turn
  // that would consume 10% of what is left gets a strong penalty). Subscriptions
  // and stale snapshots contribute nothing, so scarcity is never guessed.
  let scarcity = 0;
  if (!a.isSubscription && a.balanceRemainingUSD !== undefined) {
    const fresh = a.balanceAt === undefined || input.now - a.balanceAt <= w.scarcityStaleMs;
    if (fresh) scarcity = w.wScarcity * (costEst / Math.max(a.balanceRemainingUSD, 1e-6));
  }

  // Limit penalty: push the score up for a subscription seat that is already in
  // the rate-limit red zone (headroom below the knee). This spreads load across
  // multiple seats and fails over proactively before a 429, without the full
  // planBonus collapse that happens at headroom = 0.
  let limitPenalty = 0;
  if (a.isSubscription && a.rateHeadroom !== undefined && a.rateHeadroom < w.planHeadroomKnee) {
    limitPenalty = w.wLimit * ((w.planHeadroomKnee - a.rateHeadroom) / w.planHeadroomKnee);
  }

  // API throughput penalty: live RPM/TPM headroom parsed from response headers.
  // These windows refill in seconds to minutes, so the scorer only reacts when
  // a window is genuinely near-empty (below apiThrottleKnee). This provides
  // proactive failover before a 429 without flapping on normal per-minute noise.
  let apiThrottlePenalty = 0;
  if (!a.isSubscription && a.apiThrottle !== undefined && a.apiThrottle < w.apiThrottleKnee) {
    apiThrottlePenalty = w.wApiThrottle * ((w.apiThrottleKnee - a.apiThrottle) / w.apiThrottleKnee);
  }

  // Cache-locality nudge: charge a fraction of this turn's cost to cold models
  // so a near-tie favors the already-warm one. Scaled by wSwitch * costEst so
  // a clearly cheaper cold model still wins. Zero on the first turn (no warm
  // model yet) and zero for the warm model itself.
  const warm = !!input.warm && input.warm.accountId === a.accountId && input.warm.modelId === c.id;
  const switchPenalty = input.warm && !warm ? w.wSwitch * costEst : 0;

  // Latency bonus: when the user is waiting (interactive foreground turn), pull
  // faster models forward by a fraction of this turn's cost. Scaled by costEst
  // so the bonus is always proportional to cost: a clearly cheaper model still
  // wins, but a near-tie resolves in favor of the snappier one. Background and
  // delegated turns omit `interactive`, leaving latencyBonus at 0 so cheapest
  // wins unconditionally. tps = 0 (unknown) maps to 0.5 (mid-speed) rather than
  // 0 (slow), so missing data is treated neutrally.
  let latencyBonus = 0;
  if (input.interactive) {
    const speed = c.tps > 0 ? clamp(c.tps / TPS_REF, 0, 1) : 0.5;
    latencyBonus = w.wLatency * speed * costEst;
  }

  const score = costEst + scarcity + switchPenalty + limitPenalty + apiThrottlePenalty - planBonus - latencyBonus;
  return {
    candidate: c,
    score,
    costEst,
    terms: { costEst, scarcity, switchPenalty, limitPenalty, apiThrottlePenalty, planBonus, latencyBonus, meteredEquiv },
  };
}

/** Rank all candidates and return the best. Total-order tie-break keeps it
 *  deterministic: score asc, tps desc, quality desc, id asc.
 *  `candidates` must be non-empty — the router guarantees this (it falls back
 *  to the default model before ever scoring an empty pool). */
export function pickBest(input: ScoreInput): ScoredCandidate {
  const scored = input.candidates.map((c) => scoreCandidate(c, input));
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      b.candidate.tps - a.candidate.tps ||
      b.candidate.quality - a.candidate.quality ||
      a.candidate.id.localeCompare(b.candidate.id),
  );
  return scored[0]!;
}
