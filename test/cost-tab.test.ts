import { test, expect } from "bun:test";
import { premiumRate, estimateSavings, formatPolicyString, savingsLine } from "../src/ui/cost-tab.ts";

const registry = [
  { cost: { inUSDPerMtok: 1, outUSDPerMtok: 5 } }, // cheap
  { cost: { inUSDPerMtok: 15, outUSDPerMtok: 120 } }, // premium (blended 135)
  { cost: null }, // a CLI/seat model with no metered price
];

test("premiumRate picks the most expensive priced model; null when none priced", () => {
  expect(premiumRate(registry)).toEqual({ inUSDPerMtok: 15, outUSDPerMtok: 120 });
  expect(premiumRate([{ cost: null }])).toBeNull();
  expect(premiumRate([])).toBeNull();
});

test("estimateSavings is null when there's nothing real to compute", () => {
  const prem = premiumRate(registry);
  expect(estimateSavings([], prem, () => 0)).toBeNull();
  expect(estimateSavings([{ model: "x", inputTokens: 1, outputTokens: 1 }], null, () => 0)).toBeNull();
});

test("estimateSavings = premium baseline − actual, clamped at 0", () => {
  const prem = premiumRate(registry)!; // {15,120}
  // 1M in + 1M out on premium = 15 + 120 = $135 baseline.
  const turn = { model: "haiku", inputTokens: 1_000_000, outputTokens: 1_000_000 };
  // actual $5 → savings 130.
  expect(estimateSavings([turn], prem, () => 5)).toBeCloseTo(130, 5);
  // actual ABOVE baseline (impossible normally) clamps to 0.
  expect(estimateSavings([turn], prem, () => 999)).toBe(0);
});

test("estimateSavings counts a subscription seat's full premium cost as saved (actual $0)", () => {
  const prem = premiumRate(registry)!;
  const seat = { model: "cli:claude:opus", inputTokens: 1_000_000, outputTokens: 0 };
  expect(estimateSavings([seat], prem, () => 0)).toBeCloseTo(15, 5); // 1M in × $15/Mtok
});

test("formatPolicyString states only what the engine honours (no per-turn cap)", () => {
  expect(formatPolicyString({ mode: "routing" })).toBe("policy: cheapest model passing the quality bar");
  expect(formatPolicyString({ mode: "routing", prefer: "subscription" })).toBe(
    "policy: cheapest model passing the quality bar · prefer subscription seats",
  );
  expect(formatPolicyString({ mode: "routing", prefer: "api" })).toContain("prefer metered API");
});

test("formatPolicyString shows real budget caps (session/daily/…), never a fabricated per-turn cap", () => {
  const s = formatPolicyString({ mode: "routing", caps: { session: 5, daily: 10, monthly: 0 } });
  expect(s).toContain("session cap $5.00");
  expect(s).toContain("daily cap $10.00");
  expect(s).not.toContain("monthly"); // 0 / unset caps are omitted
  expect(s).not.toContain("/turn"); // never claims a per-turn cap
});

test("formatPolicyString reflects a pinned model / subscription honestly", () => {
  expect(formatPolicyString({ mode: "fixed", pinnedModel: "opus-4.8" })).toBe(
    "policy: pinned to opus-4.8 · /model auto to route",
  );
  expect(formatPolicyString({ mode: "subscription", subscriptionLabel: "claude · Max" })).toBe(
    "policy: claude · Max · /account off to auto-route",
  );
});

test("savingsLine shows spend always, the ~saved clause only when real", () => {
  expect(savingsLine(0.04, null)).toBe("session $0.04 spent");
  expect(savingsLine(0.04, 0.001)).toBe("session $0.04 spent"); // sub-cent savings omitted
  expect(savingsLine(0.04, 0.31)).toBe("session $0.04 spent · ~$0.31 saved vs always-premium");
});

import { sparkline, turnsLeftForecast } from "../src/ui/cost-tab.ts";

test("sparkline scales to the max and keeps zero as a baseline tick", () => {
  const s = sparkline([0, 1, 2, 4]);
  expect(s).toHaveLength(4);
  expect(s[0]).toBe("▁");
  expect(s[3]).toBe("█");
  expect(sparkline([0, 0, 0])).toBe("▁▁▁");
});

test("turnsLeftForecast: only speaks when a daily cap makes it meaningful", () => {
  expect(turnsLeftForecast({ dailyCapUSD: 5, spentTodayUSD: 4, sessionUSD: 0.5, sessionTurns: 10 })).toContain("≈20 turns left");
  expect(turnsLeftForecast({ spentTodayUSD: 1, sessionUSD: 0.5, sessionTurns: 10 })).toBeNull(); // no cap
  expect(turnsLeftForecast({ dailyCapUSD: 5, spentTodayUSD: 0, sessionUSD: 0, sessionTurns: 5 })).toBeNull(); // free session
  expect(turnsLeftForecast({ dailyCapUSD: 1000, spentTodayUSD: 0, sessionUSD: 0.01, sessionTurns: 4 })).toBeNull(); // far from the cap
});
