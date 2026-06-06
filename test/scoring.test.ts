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
  expect(best.score).toBeCloseTo(0, 5); // plan bonus cancels the cost
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
