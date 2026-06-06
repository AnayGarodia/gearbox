// The pure scoring core of the routing engine. Given a set of (model, account)
// candidates and the per-turn account-state snapshot, rank them by the DESIGN.md
// score and return the winner. This is a PURE function — no I/O, no Date.now(),
// no store reads; everything comes in via arguments — so it is fully
// fixture-testable and deterministic (same inputs → same pick).
//
//   score = costEst + scarcity + switchPenalty + limitPenalty − planBonus
//   pick  = argmin(score), tie-broken by tps↓ → quality↓ → id↑ (a total order)
//
// The guiding rule (provider research): every account-state term is ACTIVE only
// where the signal exists and NEUTRAL (0) otherwise. A subscription seat is ~free
// until its rate limit (planBonus), then ramps back to its metered-equivalent
// cost so trivial work stops burning a near-exhausted seat. Metered scarcity only
// bites where a provider exposes a (fresh) balance. Nothing here can error on a
// missing signal — absence means "no information", scored as zero.
import type { AccountState } from "./routing-context.ts";

// The minimal numeric view of a candidate the scorer needs. The router adapts
// (ModelSpec + profile + AccountState) into this, keeping the scorer free of any
// dependency on the model corpus or the registry.
export interface ScoreCandidate {
  id: string; // model id (tie-break + logging); subscription seats use cli:<account>:<sdkId>
  inUSDPerMtok: number;
  outUSDPerMtok: number;
  quality: number; // 0..1
  tps: number; // tokens/sec, for the latency-class tie-break
  account: AccountState; // the backing seat/key
}

export interface ScoreWeights {
  wScarcity: number; // penalize burning scarce metered credit
  wSwitch: number; // cold-model (cache-miss) surcharge as a FRACTION of the turn's cost
  wPlan: number; // subscription plan bonus (subtracted)
  wLimit: number; // extra push away from a seat in the rate-limit red zone
  wApiThrottle: number; // push away from a metered key whose live API window is near-empty
  planHeadroomKnee: number; // headroom ≥ knee ⇒ seat treated as ~free; below, ramps
  apiThrottleKnee: number; // API headroom ≥ knee ⇒ ignored (per-minute noise); below, ramps
  scarcityStaleMs: number; // a balance snapshot older than this is treated as unknown
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  wScarcity: 1.0,
  wSwitch: 0.15,
  wPlan: 1.0,
  wLimit: 2.0,
  wApiThrottle: 0.5,
  planHeadroomKnee: 0.2,
  apiThrottleKnee: 0.15,
  scarcityStaleMs: 15 * 60_000,
};

export interface ScoreInput {
  candidates: ScoreCandidate[];
  now: number; // injected for determinism (staleness checks)
  weights?: ScoreWeights;
  estInputTokens: number; // calibrated working-set size for the turn
  estOutputTokens?: number; // defaults to 0.2 × input (agent turns are input-heavy)
  warm?: { accountId: string; modelId: string }; // the currently-loaded model, if any
}

export interface ScoreTerms {
  costEst: number;
  scarcity: number;
  switchPenalty: number;
  limitPenalty: number;
  apiThrottlePenalty: number;
  planBonus: number; // subtracted in the score
  meteredEquiv: number; // what a subscription pick would have cost metered (for logging)
}

export interface ScoredCandidate {
  candidate: ScoreCandidate;
  score: number; // lower = better
  costEst: number;
  terms: ScoreTerms;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function scoreCandidate(c: ScoreCandidate, input: ScoreInput): ScoredCandidate {
  const w = input.weights ?? DEFAULT_WEIGHTS;
  const inTok = input.estInputTokens;
  const outTok = input.estOutputTokens ?? 0.2 * inTok;
  const costEst = (inTok / 1e6) * c.inUSDPerMtok + (outTok / 1e6) * c.outUSDPerMtok;
  const a = c.account;

  // Plan bonus: a flat-rate seat is ~free until its limit. Full bonus while
  // headroom ≥ knee, fading linearly to 0 as the binding window empties. Unknown
  // headroom ⇒ assume fresh (favor the seat we already paid for).
  let planBonus = 0;
  const meteredEquiv = costEst;
  if (a.isSubscription) {
    const headroom = a.rateHeadroom ?? 1;
    const ramp = clamp(headroom / w.planHeadroomKnee, 0, 1);
    planBonus = w.wPlan * meteredEquiv * ramp;
  }

  // Scarcity: only where the provider exposes a fresh balance. Grows as the
  // turn's cost approaches what's left. Subscriptions and unknown/stale balances
  // contribute nothing.
  let scarcity = 0;
  if (!a.isSubscription && a.balanceRemainingUSD !== undefined) {
    const fresh = a.balanceAt === undefined || input.now - a.balanceAt <= w.scarcityStaleMs;
    if (fresh) scarcity = w.wScarcity * (costEst / Math.max(a.balanceRemainingUSD, 1e-6));
  }

  // Limit penalty: push away from a seat in the red zone so load spreads / fails
  // over proactively. Fires for subscriptions with an observed window below the knee.
  let limitPenalty = 0;
  if (a.isSubscription && a.rateHeadroom !== undefined && a.rateHeadroom < w.planHeadroomKnee) {
    limitPenalty = w.wLimit * ((w.planHeadroomKnee - a.rateHeadroom) / w.planHeadroomKnee);
  }

  // API throughput penalty: live RPM/TPM headroom from response headers. These
  // refill in seconds–minutes, so we ONLY react when a window is genuinely
  // near-empty (below the knee) — proactive failover before a 429, without
  // flapping on normal per-minute fluctuation.
  let apiThrottlePenalty = 0;
  if (!a.isSubscription && a.apiThrottle !== undefined && a.apiThrottle < w.apiThrottleKnee) {
    apiThrottlePenalty = w.wApiThrottle * ((w.apiThrottleKnee - a.apiThrottle) / w.apiThrottleKnee);
  }

  // Cache-locality nudge: a fraction of the turn's own cost, charged to cold
  // models so a near-tie favors the already-warm one — but never enough to beat
  // a clearly cheaper model. Zero on the first turn (no warm model to preserve).
  const warm = !!input.warm && input.warm.accountId === a.accountId && input.warm.modelId === c.id;
  const switchPenalty = input.warm && !warm ? w.wSwitch * costEst : 0;

  const score = costEst + scarcity + switchPenalty + limitPenalty + apiThrottlePenalty - planBonus;
  return { candidate: c, score, costEst, terms: { costEst, scarcity, switchPenalty, limitPenalty, apiThrottlePenalty, planBonus, meteredEquiv } };
}

/** Rank all candidates and return the best. Total-order tie-break keeps it
 *  deterministic: score↑ → tps↓ → quality↓ → id↑. */
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
