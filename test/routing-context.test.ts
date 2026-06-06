import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRoutingContext } from "../src/model/routing-context.ts";
import type { Account } from "../src/accounts/types.ts";
import type { AccountUsage } from "../src/accounts/usage.ts";

// Isolate the store so loadBudgets() (the default when opts.budgets is omitted)
// reads an empty dir instead of the developer's real prefs.
process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gearbox-rctx-"));

// buildRoutingContext distills accounts.json + usage.json into a pure per-account
// snapshot the scorer reads. Tested by INJECTING fixtures (no disk), so the core
// is deterministic. The convenience path (no opts) reads the real store.

function acct(over: Partial<Account> & Pick<Account, "id" | "provider" | "exec">): Account {
  return { label: over.id ?? "", auth: { kind: "api-key", ref: "r" }, enabled: true, addedAt: 0, ...over } as Account;
}
function usage(over: Partial<AccountUsage> & Pick<AccountUsage, "accountId">): AccountUsage {
  return { spentUSD: 0, inputTokens: 0, outputTokens: 0, turns: 0, estimated: false, firstAt: 0, lastAt: 0, ...over };
}

test("maps exec mode to isSubscription", () => {
  const ctx = buildRoutingContext(1000, {
    accounts: [acct({ id: "max", provider: "claude-cli", exec: "cli" }), acct({ id: "key", provider: "anthropic", exec: "in-loop" })],
    usage: [],
  });
  expect(ctx.byAccountId.get("max")!.isSubscription).toBe(true);
  expect(ctx.byAccountId.get("key")!.isSubscription).toBe(false);
});

test("rate headroom is the MIN over windows (the binding window governs)", () => {
  // 5h fresh (0.1 used → 0.9 headroom) but 7d nearly spent (0.9 used → 0.1 headroom).
  const ctx = buildRoutingContext(1000, {
    accounts: [acct({ id: "max", provider: "claude-cli", exec: "cli" })],
    usage: [usage({ accountId: "max", rates: [
      { utilization: 0.1, type: "five_hour", resetsAt: 5, at: 1 },
      { utilization: 0.9, type: "seven_day", resetsAt: 7, at: 1 },
    ] })],
  });
  const s = ctx.byAccountId.get("max")!;
  expect(s.rateHeadroom).toBeCloseTo(0.1, 5);
  expect(s.bindingWindow?.type).toBe("seven_day");
  expect(s.bindingWindow?.resetsAt).toBe(7);
});

test("utilization is clamped to [0,1] before computing headroom", () => {
  const ctx = buildRoutingContext(1000, {
    accounts: [acct({ id: "max", provider: "claude-cli", exec: "cli" })],
    usage: [usage({ accountId: "max", rates: [{ utilization: 1.4, type: "five_hour", at: 1 }] })],
  });
  expect(ctx.byAccountId.get("max")!.rateHeadroom).toBe(0); // not negative
});

test("copies a known balance and leaves it undefined when absent", () => {
  const ctx = buildRoutingContext(1000, {
    accounts: [acct({ id: "or", provider: "openrouter", exec: "in-loop" }), acct({ id: "an", provider: "anthropic", exec: "in-loop" })],
    usage: [usage({ accountId: "or", balance: { remainingUSD: 12.5, totalUSD: 20, at: 50 } })],
  });
  expect(ctx.byAccountId.get("or")!.balanceRemainingUSD).toBe(12.5);
  expect(ctx.byAccountId.get("or")!.balanceTotalUSD).toBe(20);
  expect(ctx.byAccountId.get("an")!.balanceRemainingUSD).toBeUndefined(); // no scarcity signal
});

test("falls back to the legacy single rate field when rates[] is absent", () => {
  const ctx = buildRoutingContext(1000, {
    accounts: [acct({ id: "max", provider: "claude-cli", exec: "cli" })],
    usage: [usage({ accountId: "max", rate: { utilization: 0.4, type: "five_hour", at: 1 } })],
  });
  expect(ctx.byAccountId.get("max")!.rateHeadroom).toBeCloseTo(0.6, 5);
});

test("estimates a balance from a budget − spend when the provider exposes none", () => {
  const ctx = buildRoutingContext(1000, {
    accounts: [acct({ id: "oai", provider: "openai", exec: "in-loop" })],
    usage: [usage({ accountId: "oai", spentUSD: 7.5, monthKey: "1970-01", monthSpentUSD: 7.5 })],
    budgets: { openai: { amountUSD: 20, period: "total" } }, // keyed by provider
  });
  const s = ctx.byAccountId.get("oai")!;
  expect(s.balanceRemainingUSD).toBe(12.5); // 20 − 7.5
  expect(s.balanceTotalUSD).toBe(20);
  expect(s.balanceEstimated).toBe(true);
});

test("a live balance wins over a budget estimate", () => {
  const ctx = buildRoutingContext(1000, {
    accounts: [acct({ id: "or", provider: "openrouter", exec: "in-loop" })],
    usage: [usage({ accountId: "or", spentUSD: 5, balance: { remainingUSD: 99, totalUSD: 100, at: 50 } })],
    budgets: { or: { amountUSD: 20, period: "total" } },
  });
  const s = ctx.byAccountId.get("or")!;
  expect(s.balanceRemainingUSD).toBe(99); // the real figure, not 15
  expect(s.balanceEstimated).toBeUndefined();
});

test("an account-id budget beats a provider budget, and clamps at 0", () => {
  const ctx = buildRoutingContext(1000, {
    accounts: [acct({ id: "oai", provider: "openai", exec: "in-loop" })],
    usage: [usage({ accountId: "oai", spentUSD: 30 })],
    budgets: { oai: { amountUSD: 20, period: "total" }, openai: { amountUSD: 999, period: "total" } },
  });
  expect(ctx.byAccountId.get("oai")!.balanceRemainingUSD).toBe(0); // 20 − 30, clamped
});

test("api:* windows feed apiThrottle, kept separate from subscription headroom", () => {
  const ctx = buildRoutingContext(1000, {
    accounts: [acct({ id: "key", provider: "anthropic", exec: "in-loop" })],
    usage: [usage({ accountId: "key", rates: [
      { utilization: 0.95, type: "api:tokens", resetsAt: 60, at: 1 }, // near-empty per-minute window
      { utilization: 0.3, type: "api:requests", at: 1 },
    ] })],
  });
  const s = ctx.byAccountId.get("key")!;
  expect(s.apiThrottle).toBeCloseTo(0.05, 5); // min(1-0.95, 1-0.3)
  expect(s.rateHeadroom).toBeUndefined(); // api windows don't count as subscription headroom
});

test("skips disabled accounts and leaves headroom/balance undefined with no usage", () => {
  const ctx = buildRoutingContext(1000, {
    accounts: [acct({ id: "on", provider: "anthropic", exec: "in-loop" }), acct({ id: "off", provider: "openai", exec: "in-loop", enabled: false })],
    usage: [],
  });
  expect(ctx.byAccountId.has("off")).toBe(false);
  const s = ctx.byAccountId.get("on")!;
  expect(s.rateHeadroom).toBeUndefined();
  expect(s.balanceRemainingUSD).toBeUndefined();
});
