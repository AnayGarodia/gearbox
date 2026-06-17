import { test, expect } from "bun:test";
import { pickBest, scoreCandidate, DEFAULT_WEIGHTS, type ScoreCandidate, type ScoreInput } from "../src/model/scoring.ts";
import type { AccountState } from "../src/model/routing-context.ts";

const NOW = 1_000_000;

function state(over: Partial<AccountState> & Pick<AccountState, "accountId">): AccountState {
  return { provider: "x", exec: "in-loop", isSubscription: false, ...over } as AccountState;
}
function cand(over: Partial<ScoreCandidate> & Pick<ScoreCandidate, "id" | "account">): ScoreCandidate {
  return { inUSDPerMtok: 3, outUSDPerMtok: 15, quality: 0.8, tps: 100, ...over } as ScoreCandidate;
}
function input(candidates: ScoreCandidate[], over: Partial<ScoreInput> = {}): ScoreInput {
  return { candidates, now: NOW, estInputTokens: 10_000, ...over };
}

// ── subscription-first ──
test("a fresh subscription seat beats the same model on a metered key", () => {
  const seatAcct = state({ accountId: "max", exec: "cli", isSubscription: true, rateHeadroom: 1 });
  const keyAcct = state({ accountId: "key" });
  const seat = cand({ id: "cli:max:sonnet", account: seatAcct });
  const key = cand({ id: "sonnet", account: keyAcct });
  const best = pickBest(input([key, seat]));
  expect(best.candidate.id).toBe("cli:max:sonnet");
  // The plan bonus cancels the seat's DOLLARS (its costEst term), so the seat
  // beats the identical metered key. The quality + latency expected-costs are
  // identical for both (same model), so the seat wins purely on the free dollars.
  expect(best.terms.planBonus).toBeCloseTo(best.terms.costEst, 5);
  expect(best.score).toBeLessThan(scoreCandidate(key, input([key])).score);
});

// ── seat exhaustion → failover before a hard 429 ──
test("a nearly-exhausted seat loses to a cheaper metered model", () => {
  const seat = cand({ id: "cli:max:sonnet", inUSDPerMtok: 3, account: state({ accountId: "max", exec: "cli", isSubscription: true, rateHeadroom: 0.05 }) });
  const cheap = cand({ id: "haiku", inUSDPerMtok: 0.8, account: state({ accountId: "key" }) });
  const best = pickBest(input([seat, cheap]));
  expect(best.candidate.id).toBe("haiku");
});

test("the plan bonus ramps monotonically as headroom falls 1→0", () => {
  const mk = (h: number) => scoreCandidate(
    cand({ id: "cli:max:sonnet", account: state({ accountId: "max", exec: "cli", isSubscription: true, rateHeadroom: h }) }),
    input([]),
  ).score;
  const scores = [1, 0.8, 0.6, 0.4, 0.2, 0.1, 0].map(mk);
  for (let i = 1; i < scores.length; i++) expect(scores[i]!).toBeGreaterThanOrEqual(scores[i - 1]! - 1e-9);
});

// ── latency class: interactive prefers fast; background prefers cheap ──
test("interactive prefers a faster model over a slightly cheaper slower one; background does not", () => {
  const slowCheap = cand({ id: "slow-cheap", inUSDPerMtok: 1, outUSDPerMtok: 5, tps: 65, account: state({ accountId: "a" }) });
  const fastPricey = cand({ id: "fast-pricey", inUSDPerMtok: 1.2, outUSDPerMtok: 6, tps: 180, account: state({ accountId: "b" }) });
  // Background (default): cheapest wins.
  expect(pickBest(input([slowCheap, fastPricey])).candidate.id).toBe("slow-cheap");
  // Interactive (user waiting): the latency nudge flips a SMALL cost gap toward fast.
  expect(pickBest(input([slowCheap, fastPricey], { interactive: true })).candidate.id).toBe("fast-pricey");
});

test("interactive does NOT pay a large premium for speed (scaled by the turn's own cost)", () => {
  const cheap = cand({ id: "cheap", inUSDPerMtok: 1, outUSDPerMtok: 5, tps: 65, account: state({ accountId: "a" }) });
  const pricey = cand({ id: "pricey", inUSDPerMtok: 4, outUSDPerMtok: 20, tps: 180, account: state({ accountId: "b" }) });
  expect(pickBest(input([cheap, pricey], { interactive: true })).candidate.id).toBe("cheap"); // 4x gap stays cheap
});

// ── scarcity (metered balance) ──
test("a scarce metered balance is deprioritized; a flush one is not", () => {
  const a = cand({ id: "a", inUSDPerMtok: 3, account: state({ accountId: "scarce", provider: "deepseek", balanceRemainingUSD: 0.4, balanceAt: NOW }) });
  const b = cand({ id: "b", inUSDPerMtok: 3.05, account: state({ accountId: "flush", provider: "openrouter", balanceRemainingUSD: 500, balanceAt: NOW }) });
  // a is nominally cheaper but nearly out of credit → b should win.
  expect(pickBest(input([a, b])).candidate.id).toBe("b");
});

test("unknown balance is neutral (no scarcity penalty)", () => {
  const a = cand({ id: "a", inUSDPerMtok: 3, account: state({ accountId: "anthropic" }) }); // no balance field
  const b = cand({ id: "b", inUSDPerMtok: 4, account: state({ accountId: "openai" }) });
  expect(pickBest(input([a, b])).candidate.id).toBe("a"); // pure cost order
  expect(scoreCandidate(a, input([a])).terms.scarcity).toBe(0);
});

test("a stale balance snapshot is treated as unknown", () => {
  const old = NOW - DEFAULT_WEIGHTS.scarcityStaleMs - 1;
  const c = cand({ id: "a", account: state({ accountId: "or", provider: "openrouter", balanceRemainingUSD: 0.01, balanceAt: old }) });
  expect(scoreCandidate(c, input([c])).terms.scarcity).toBe(0); // don't route on a stale reading
});

// ── switch penalty (cache locality) ──
test("the switch penalty tips a tie toward the warm model but not against a clearly cheaper one", () => {
  const warm = cand({ id: "warm", inUSDPerMtok: 3, account: state({ accountId: "k" }) });
  const cold = cand({ id: "cold", inUSDPerMtok: 3, account: state({ accountId: "k" }) });
  expect(pickBest(input([cold, warm], { warm: { accountId: "k", modelId: "warm" } })).candidate.id).toBe("warm");

  const cheaper = cand({ id: "cheaper", inUSDPerMtok: 1, account: state({ accountId: "k" }) });
  expect(pickBest(input([cheaper, warm], { warm: { accountId: "k", modelId: "warm" } })).candidate.id).toBe("cheaper");
});

// ── live API throughput headroom (from response headers) ──
test("a near-empty API window deprioritizes that key, but normal headroom is ignored", () => {
  const cheapButThrottled = cand({ id: "a", inUSDPerMtok: 1, account: state({ accountId: "k1", apiThrottle: 0.02 }) });
  const pricier = cand({ id: "b", inUSDPerMtok: 3, account: state({ accountId: "k2" }) });
  // a is cheaper but almost out of per-minute quota → b wins (proactive failover).
  expect(pickBest(input([cheapButThrottled, pricier])).candidate.id).toBe("b");

  // At healthy headroom (0.5) the penalty is zero — no flapping; cheapest wins.
  const healthy = cand({ id: "a", inUSDPerMtok: 1, account: state({ accountId: "k1", apiThrottle: 0.5 }) });
  expect(pickBest(input([healthy, pricier])).candidate.id).toBe("a");
  expect(scoreCandidate(healthy, input([healthy])).terms.apiThrottlePenalty).toBe(0);
});

// ── determinism ──
test("identical scores resolve by tps→quality→id for a total order", () => {
  const base = () => state({ accountId: "k" });
  const x = cand({ id: "x", quality: 0.8, tps: 100, account: base() });
  const y = cand({ id: "y", quality: 0.8, tps: 100, account: base() });
  const z = cand({ id: "z", quality: 0.8, tps: 120, account: base() }); // faster → wins
  expect(pickBest(input([x, y, z])).candidate.id).toBe("z");
  // shuffle input order → same winner
  expect(pickBest(input([z, y, x])).candidate.id).toBe("z");
  // drop z: x and y tie on everything but id → "x" (asc)
  expect(pickBest(input([y, x])).candidate.id).toBe("x");
});

// ── cost-realism terms (v0.10 routing upgrades) ──────────────────────────────
const acct = (id: string, sub = false) => ({ accountId: id, provider: "p", exec: "in-loop" as const, isSubscription: sub });
const base = { id: "m", inUSDPerMtok: 1, outUSDPerMtok: 4, quality: 0.8, tps: 100, account: acct("a") };
const flags = { candidates: [], now: 1_000_000, estInputTokens: 100_000 };

test("failure-adjusted cost: a measured repo fail rate raises the wrong-cost term (the flywheel feeds the objective)", () => {
  // No verifier net so a miss is costly enough to be visible in the score.
  const ctx = { ...flags, verifierTier: "none" as const };
  const clean = scoreCandidate({ ...base }, ctx);
  const flaky = scoreCandidate({ ...base, failRate: 0.5 }, ctx);
  expect(flaky.terms.wrongCost).toBeGreaterThan(clean.terms.wrongCost);
  expect(flaky.terms.pWrong).toBeGreaterThan(clean.terms.pWrong);
  expect(flaky.score).toBeGreaterThan(clean.score);
  // dollar cost is unchanged — failure cost is no longer folded into costEst.
  expect(flaky.costEst).toBeCloseTo(clean.costEst, 6);
});

test("cache-aware cost: the warm model on a caching provider gets the read discount; cold pays sticker", () => {
  const warm = { accountId: "a", modelId: "m" };
  const hot = scoreCandidate({ ...base, cacheReadDiscount: 0.1 }, { ...flags, warm });
  const cold = scoreCandidate({ ...base, cacheReadDiscount: 0.1, account: acct("b") }, { ...flags, warm });
  expect(hot.terms.cacheSavings).toBeGreaterThan(0);
  expect(cold.terms.cacheSavings).toBe(0);
  expect(hot.costEst).toBeLessThan(cold.costEst);
  // EVERY cold candidate pays the same flat stickiness nudge (symmetric —
  // exempting caching providers skewed cold-vs-cold comparisons toward them);
  // the warm model's cache discount rides on top.
  expect(cold.terms.switchPenalty).toBeGreaterThan(0);
  const coldNoCache = scoreCandidate({ ...base, account: acct("b") }, { ...flags, warm });
  expect(coldNoCache.terms.switchPenalty).toBeGreaterThan(0);
});

test("output realism: a reasoning model's outputFactor raises its cost", () => {
  const terse = scoreCandidate({ ...base }, flags);
  const thinky = scoreCandidate({ ...base, outputFactor: 1.0 }, flags);
  expect(thinky.costEst).toBeGreaterThan(terse.costEst);
  expect(thinky.terms.stickerCost).toBeCloseTo((100_000 / 1e6) * 1 + (100_000 / 1e6) * 4, 6);
});

test("the verifier net shifts the quality/cost tradeoff: no net → quality wins, a net pulls toward cost", () => {
  // Comparable quality, strong moderately pricier — a near-tie that the net flips.
  const weak = { ...base, id: "weak", quality: 0.80, inUSDPerMtok: 1, outUSDPerMtok: 4 };
  const strong = { ...base, id: "strong", quality: 0.82, inUSDPerMtok: 1.6, outUSDPerMtok: 6.4 };
  // On a task with REAL difficulty: NO net → a miss ships silently → quality
  // dominates → the stronger model wins.
  const hardExposed = { ...flags, difficulty: 0.5, verifierTier: "none" as const };
  expect(pickBest({ ...hardExposed, candidates: [weak, strong] }).candidate.id).toBe("strong");
  // WITH a net → a miss is caught & re-run → cost matters more → the cheaper wins.
  const hardNetted = { ...flags, difficulty: 0.5, verifierTier: "tests" as const };
  expect(pickBest({ ...hardNetted, candidates: [weak, strong] }).candidate.id).toBe("weak");
  // A difficulty-0 (simple) task carries NO quality pressure under ANY net — the
  // cheaper model wins even with no net (marginal quality isn't worth a premium).
  const simpleExposed = { ...flags, difficulty: 0, verifierTier: "none" as const };
  expect(pickBest({ ...simpleExposed, candidates: [weak, strong] }).candidate.id).toBe("weak");
  // higher quality → strictly lower P(wrong) and wrong-cost (when difficulty bites).
  const wq = scoreCandidate(weak, hardExposed).terms;
  const sq = scoreCandidate(strong, hardExposed).terms;
  expect(sq.pWrong).toBeLessThan(wq.pWrong);
  expect(sq.wrongCost).toBeLessThan(wq.wrongCost);
});

test("preferBias resolves near-ties toward the preferred account, never beats real cost gaps", () => {
  const a = { ...base, id: "x", account: acct("first") };
  const b = { ...base, id: "x2", account: acct("second") };
  // equal cost → the biased one wins
  expect(pickBest({ ...flags, candidates: [{ ...a, preferBias: 0.1 }, b] }).candidate.id).toBe("x");
  // a 3x cheaper rival still wins over a 0.1 bias
  const cheap = { ...b, inUSDPerMtok: 0.3, outUSDPerMtok: 1.2 };
  expect(pickBest({ ...flags, candidates: [{ ...a, preferBias: 0.1 }, cheap] }).candidate.id).toBe("x2");
});
