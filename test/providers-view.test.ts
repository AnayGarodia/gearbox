import { test, expect } from "bun:test";
import { healthDotColor, healthDotGlyph, providerRow, buildProvidersView } from "../src/ui/providers-view.ts";
import { color, glyph } from "../src/ui/theme.ts";
import type { Account, HealthState } from "../src/accounts/types.ts";
import type { AccountUsage } from "../src/accounts/usage.ts";

function acct(p: { provider: string; label?: string; exec?: "in-loop" | "cli"; slug?: string; state?: HealthState }): Account {
  return {
    id: p.label ?? p.provider,
    slug: p.slug,
    label: p.label ?? p.provider,
    provider: p.provider,
    exec: p.exec ?? "in-loop",
    enabled: true,
    addedAt: 0,
    auth: {} as any,
    health: p.state ? { state: p.state, checkedAt: 0 } : undefined,
  } as unknown as Account;
}
function usage(p: { spentUSD?: number; remainingUSD?: number }): AccountUsage {
  return {
    accountId: "x",
    spentUSD: p.spentUSD ?? 0,
    inputTokens: 0,
    outputTokens: 0,
    turns: 0,
    estimated: false,
    balance: p.remainingUSD != null ? { remainingUSD: p.remainingUSD, at: 0 } : undefined,
  } as unknown as AccountUsage;
}

test("healthDotColor maps each state: ready/attention/broken/unknown", () => {
  expect(healthDotColor("ok")).toBe(color.ok);
  expect(healthDotColor("expired")).toBe(color.warn);
  expect(healthDotColor("rate-limited")).toBe(color.warn);
  expect(healthDotColor("invalid")).toBe(color.err);
  expect(healthDotColor("no-credit")).toBe(color.err);
  expect(healthDotColor("real-error")).toBe(color.err);
  expect(healthDotColor("unknown")).toBe(color.faint);
  expect(healthDotColor(undefined)).toBe(color.faint);
});

test("healthDotGlyph is filled when known, hollow when unprobed/unknown", () => {
  expect(healthDotGlyph("ok")).toBe(glyph.on);
  expect(healthDotGlyph("invalid")).toBe(glyph.on);
  expect(healthDotGlyph("unknown")).toBe(glyph.off);
  expect(healthDotGlyph(undefined)).toBe(glyph.off);
});

test("a real balance shows ONLY for a balance-exposing provider with a fresh figure", () => {
  const r = providerRow(acct({ provider: "deepseek", state: "ok" }), usage({ remainingUSD: 12.4 }));
  expect(r.right).toBe("$12.40 left");
});

test("a balance-exposing provider with no balance falls back to real spend", () => {
  const r = providerRow(acct({ provider: "openrouter", state: "ok" }), usage({ spentUSD: 0.03 }));
  expect(r.right).toBe("$0.03 spent");
});

test("a provider that cannot expose a balance shows spend, or an explicit 'balance n/a'", () => {
  const spent = providerRow(acct({ provider: "anthropic", state: "ok" }), usage({ spentUSD: 0.03 }));
  expect(spent.right).toBe("$0.03 spent");
  const none = providerRow(acct({ provider: "anthropic", state: "ok" }), usage({}));
  expect(none.right).toBe("balance n/a"); // never a fabricated number
});

test("a balance-exposing provider with neither balance nor spend stays quiet (no n/a noise)", () => {
  const r = providerRow(acct({ provider: "openrouter", state: "ok" }), usage({}));
  expect(r.right).toBe("");
});

test("a broken account carries the exact fix command", () => {
  const invalid = providerRow(acct({ provider: "anthropic", state: "invalid" }), usage({}));
  expect(invalid.broken).toBe(true);
  expect(invalid.fixCmd).toContain("replace the key: /account add anthropic");
  const expiredCli = providerRow(acct({ provider: "anthropic", exec: "cli", slug: "claude-work", state: "expired" }), usage({}));
  expect(expiredCli.fixCmd).toBe("re-login: /account login claude-work");
  const limited = providerRow(acct({ provider: "openrouter", state: "rate-limited" }), usage({}));
  expect(limited.fixCmd).toContain("wait, or switch");
});

test("a healthy account has no fix command", () => {
  expect(providerRow(acct({ provider: "anthropic", state: "ok" }), usage({})).fixCmd).toBeUndefined();
});

test("buildProvidersView sorts healthy → attention → broken, then by label", () => {
  expect(buildProvidersView([], () => undefined)).toEqual([]);
  const rows = buildProvidersView(
    [
      acct({ provider: "p1", label: "broken-key", state: "invalid" }),
      acct({ provider: "p2", label: "ready-b", state: "ok" }),
      acct({ provider: "p3", label: "limited", state: "rate-limited" }),
      acct({ provider: "p4", label: "ready-a", state: "ok" }),
    ],
    () => undefined,
  );
  expect(rows.map((r) => r.label)).toEqual(["ready-a", "ready-b", "limited", "broken-key"]);
});
