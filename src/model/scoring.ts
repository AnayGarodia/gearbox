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
  // ── cost-realism inputs (all optional; absent = the old behavior) ──────────
  // Measured per-repo verify-fail rate (priors.failRateFor). A model that fails
  // 30% of the time here is NOT cheap: each red VERIFY costs iterate-to-green
  // re-runs and an eventual escalation to a stronger model, so its expected
  // delivered-green cost is sticker × (1 + wRetry·failRate).
  failRate?: number;
  // Provider's prompt-cache READ price as a fraction of normal input price
  // (anthropic 0.1, …). Drives the cache-aware warm discount: re-running the
  // warm model re-reads most of the input at this fraction; switching models
  // forfeits that, which is the REAL switch cost (the flat wSwitch penalty
  // remains only for non-caching providers).
  cacheReadDiscount?: number;
  // Expected output tokens as a fraction of input for agent turns (profiles
  // outputFactorFor). Reasoning models emit several times the default 0.2 —
  // at output prices that's where "cheap" thinking models stop being cheap.
  outputFactor?: number;
  // Kind-weighted value of quality ABOVE the bar (router sets ~0.3 for
  // code/plan, 0 for cheap kinds): a near-tie resolves toward the stronger
  // model where correctness compounds, while cheap kinds stay pure-cost.
  qualityWeight?: number;
  // The task's quality bar — the bonus pays only for SURPLUS above it.
  // Rewarding absolute quality let a pricey metered model outscore a free
  // seat purely on its benchmark number; surplus rewards only what the task
  // didn't already demand.
  qualityBar?: number;
  // Standing user-preference bias as a FRACTION of this turn's cost, computed
  // by the router from the policy (accountOrder rank, useFirst drain bias).
  // Positive = preferred (subtracted from the score). Cost-commensurate, so a
  // clearly cheaper rival still wins; preference resolves the near-ties.
  preferBias?: number;
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
  wRetry: number; // expected-retry multiplier on the measured verify-fail rate (failure-adjusted cost)
  cachedShare: number; // fraction of input assumed cache-READABLE on the warm model (system+history prefix)
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
  // A red VERIFY costs ~1.5 extra attempts on average (iterate-to-green re-runs
  // plus the escalated retry on a stronger model), so expected cost grows by
  // 1.5× the fail rate. Conservative: the real cost includes the user's time.
  wRetry: 1.5,
  // In a settled session the byte-stable prefix (system + history before the
  // cache break) dominates the request; ~70% of input re-reads from cache on
  // the warm model. Used only where the provider actually discounts cache reads.
  cachedShare: 0.7,
  planHeadroomKnee: 0.2,
  apiThrottleKnee: 0.15,
  scarcityStaleMs: 15 * 60_000,
};

// The reference tps at or above which a model is considered fully "fast"
// (approximately haiku-class at ~150 tok/s). Models with no latency data (tps 0)
// are treated as mid-speed (0.5) rather than assumed slow, so missing data is
// never punished.
const TPS_REF = 150;

// Reference turn price for the quality bonus (blended $/Mtok of a mid-tier
// coding model): quality above the bar is worth qualityWeight × quality × this,
// independent of the candidate's own price.
const QUALITY_REF_USD_PER_MTOK = 5;

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
  costEst: number; // cache-aware, failure-adjusted expected cost (the real number being minimized)
  stickerCost: number; // plain tokens × price, before cache/retry adjustments (informational)
  retryPenalty: number; // the failure-adjusted surcharge included in costEst
  cacheSavings: number; // the warm-model cache discount included in costEst (0 when cold / no caching)
  scarcity: number;
  switchPenalty: number;
  limitPenalty: number;
  apiThrottlePenalty: number;
  planBonus: number; // subtracted in the score
  latencyBonus: number; // subtracted in the score (interactive: faster models get a higher bonus)
  qualityBonus: number; // subtracted in the score (kind-weighted value of quality above the bar)
  preferBonus: number; // subtracted in the score (standing user preference: account order / spend-first)
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
  // Output estimate: per-model verbosity factor (reasoning models emit several
  // times the 0.2 default, at output prices) unless the caller fixed it.
  const outTok = input.estOutputTokens ?? (c.outputFactor ?? 0.2) * inTok;
  // Sticker cost: plain tokens × price for this turn's token budget.
  const stickerCost = (inTok / 1e6) * c.inUSDPerMtok + (outTok / 1e6) * c.outUSDPerMtok;
  const a = c.account;
  const isWarm = !!input.warm && input.warm.accountId === a.accountId && input.warm.modelId === c.id;

  // Cache-aware input cost: the WARM model re-reads the stable prefix
  // (~cachedShare of input) at the provider's cache-read fraction. This is the
  // real economics behind stickiness — a rival must be cheaper net of the
  // forfeited cache discount, not nominally cheaper. Cold candidates and
  // non-caching providers pay sticker. (Cache WRITE premiums are ignored:
  // ~1.25× on a one-time write is noise next to a 10× read discount.)
  let cacheSavings = 0;
  if (isWarm && c.cacheReadDiscount != null && c.cacheReadDiscount < 1) {
    cacheSavings = (inTok / 1e6) * c.inUSDPerMtok * w.cachedShare * (1 - c.cacheReadDiscount);
  }

  // Failure-adjusted expected cost: a model with a measured verify-fail rate
  // here costs sticker × (1 + wRetry·failRate) to actually deliver green —
  // failures trigger iterate-to-green re-runs and an escalated retry. This is
  // what makes "cheapest that clears the bar" mean cheapest DELIVERED, not
  // cheapest attempted.
  const retryPenalty = (stickerCost - cacheSavings) * w.wRetry * (c.failRate ?? 0);

  // The cost actually minimized: cache-aware, failure-adjusted.
  const costEst = stickerCost - cacheSavings + retryPenalty;

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

  // Cache-locality nudge: every COLD candidate pays the same flat fraction
  // (symmetric — exempting caching providers skewed cold-vs-cold comparisons
  // toward them), and the WARM model additionally keeps its real cache-read
  // discount above. The mild overlap (a caching rival pays the nudge while
  // the warm one banks the discount) is intentional stickiness, not an error.
  const switchPenalty = input.warm && !isWarm ? w.wSwitch * costEst : 0;

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

  // Quality bonus: above-bar quality is worth a kind-weighted, REFERENCE-priced
  // amount (not a fraction of the candidate's own cost — that gave expensive
  // models bigger bonuses just for being expensive). The reference is a fixed
  // $/Mtok turn price, so the bonus rewards quality alone and a genuinely
  // cheaper model still wins any real cost gap. Subscription seats skip it:
  // their true marginal cost is QUOTA burn (a pricier model drains the 5h
  // window faster), which the cheapest-clearing default already respects.
  const refCost = (inTok / 1e6) * QUALITY_REF_USD_PER_MTOK;
  const qualitySurplus = clamp(c.quality - (c.qualityBar ?? 0), 0, 1);
  const qualityBonus = a.isSubscription ? 0 : (c.qualityWeight ?? 0) * qualitySurplus * refCost;

  // Standing-preference bias (policy accountOrder / useFirst), already scaled
  // to a fraction of cost by the router.
  const preferBonus = (c.preferBias ?? 0) * costEst;

  const score = costEst + scarcity + switchPenalty + limitPenalty + apiThrottlePenalty - planBonus - latencyBonus - qualityBonus - preferBonus;
  return {
    candidate: c,
    score,
    costEst,
    terms: { costEst, stickerCost, retryPenalty, cacheSavings, scarcity, switchPenalty, limitPenalty, apiThrottlePenalty, planBonus, latencyBonus, qualityBonus, preferBonus, meteredEquiv },
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
