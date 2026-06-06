import { test, expect } from "bun:test";
import { spentInPeriod, type AccountUsage } from "../src/accounts/usage.ts";

const JAN = Date.parse("2026-01-15T00:00:00Z");
const FEB = Date.parse("2026-02-15T00:00:00Z");

function u(over: Partial<AccountUsage>): AccountUsage {
  return { accountId: "a", spentUSD: 0, inputTokens: 0, outputTokens: 0, turns: 0, estimated: false, firstAt: 0, lastAt: 0, ...over };
}

test("total period returns cumulative spend", () => {
  expect(spentInPeriod(u({ spentUSD: 42 }), "total", JAN)).toBe(42);
});

test("monthly period returns the current month's spend only", () => {
  const acct = u({ spentUSD: 42, monthKey: "2026-01", monthSpentUSD: 9 });
  expect(spentInPeriod(acct, "monthly", JAN)).toBe(9);
});

test("monthly period resets to 0 once the month has rolled over", () => {
  const acct = u({ spentUSD: 42, monthKey: "2026-01", monthSpentUSD: 9 });
  expect(spentInPeriod(acct, "monthly", FEB)).toBe(0); // stale month ⇒ this month is fresh
});
