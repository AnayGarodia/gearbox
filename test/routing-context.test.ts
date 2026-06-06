import { test, expect } from "bun:test";
import { buildRoutingContext } from "../src/model/routing-context.ts";
import type { Account } from "../src/accounts/types.ts";
import type { AccountUsage } from "../src/accounts/usage.ts";

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
