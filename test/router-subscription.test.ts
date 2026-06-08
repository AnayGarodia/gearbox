import { test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoutingSelector, SubscriptionPinSelector } from "../src/model/router.ts";
import { subscriptionSeats } from "../src/providers.ts";
import { putAccount } from "../src/accounts/store.ts";
import { recordUsage, recordRateLimits } from "../src/accounts/usage.ts";
import type { Account } from "../src/accounts/types.ts";

// Isolate the store + a single env key so the only API model is Anthropic and the
// only seat is the claude-cli account we add. Both can serve sonnet-4.6.
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ["ANTHROPIC_API_KEY", "GEARBOX_HOME"]) saved[k] = process.env[k];
  process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gearbox-sub-"));
  process.env.ANTHROPIC_API_KEY = "test-key";
});
afterEach(() => {
  for (const k of ["ANTHROPIC_API_KEY", "GEARBOX_HOME"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

// A rate window resets in the FUTURE (epoch seconds) — a genuinely-exhausted window
// is not yet expired. (A past resetsAt is now correctly ignored as stale.)
const futureSec = () => Math.floor(Date.now() / 1000) + 3600;

function claudeSeat(): Account {
  return {
    id: "claude-max", label: "Claude Max", provider: "claude-cli", exec: "cli",
    auth: { kind: "cli", binary: "claude" }, models: ["claude-sonnet-4-6"],
    enabled: true, addedAt: 0,
  };
}

// A Claude Pro/Max seat with NO explicit model list falls back to the claude-cli
// catalog defaultModels — which must expose haiku (usable via `claude --model
// haiku`), not just sonnet/opus. Regression: haiku showed as API-only.
test("a claude subscription seat exposes haiku/sonnet/opus from the catalog", () => {
  putAccount({ id: "claude-max-cat", label: "Claude Max", provider: "claude-cli", exec: "cli", auth: { kind: "cli", binary: "claude" }, enabled: true, addedAt: 0 });
  const ids = subscriptionSeats().filter((s) => s.account.id === "claude-max-cat").map((s) => s.spec.sdkId);
  expect(ids).toContain("claude-haiku-4-5");
  expect(ids).toContain("claude-sonnet-4-6");
  expect(ids).toContain("claude-opus-4-8");
});

test("a stale CLI account snapshot still gains new catalog models (haiku) via union", () => {
  // Mirrors a real account added BEFORE haiku was in the catalog (the reported bug).
  putAccount({ id: "claude-stale", label: "Claude Max", provider: "claude-cli", exec: "cli", auth: { kind: "cli", binary: "claude" }, models: ["claude-opus-4-8", "claude-sonnet-4-6"], enabled: true, addedAt: 0 });
  const ids = subscriptionSeats().filter((s) => s.account.id === "claude-stale").map((s) => s.spec.sdkId);
  expect(ids).toContain("claude-haiku-4-5"); // healed from the live catalog despite the frozen snapshot
  expect(ids).toContain("claude-sonnet-4-6"); // existing snapshot models preserved
});

test("a cheap task can route to the free claude seat once haiku is exposed", () => {
  putAccount({ id: "claude-max-cheap", label: "Claude Max", provider: "claude-cli", exec: "cli", auth: { kind: "cli", binary: "claude" }, enabled: true, addedAt: 0 });
  // A bounded sub-task (bar 0): a ~free subscription seat wins over the metered key.
  const choice = new RoutingSelector().select({ prompt: "summarize this transcript", kind: "summarize" });
  expect(choice.backend?.kind).toBe("cli");
});

test("a configured subscription seat wins over the same model on a metered key", () => {
  putAccount(claudeSeat());
  const choice = new RoutingSelector().select({ prompt: "refactor the parser" });
  expect(choice.backend?.kind).toBe("cli");
  expect((choice.backend as any).binary).toBe("claude");
  expect(choice.model.sdkId).toBe("claude-sonnet-4-6"); // same model, free seat
});

test("an exhausted seat fails over to the metered API model", () => {
  putAccount(claudeSeat());
  // Seed usage then record a nearly-spent weekly window for the seat.
  recordUsage({ accountId: "claude-max", inputTokens: 1, outputTokens: 1, costUSD: 0, estimated: false });
  recordRateLimits("claude-max", [{ utilization: 0.99, type: "seven_day", resetsAt: futureSec() }]);
  const choice = new RoutingSelector().select({ prompt: "refactor the parser" });
  expect(choice.backend?.kind).toBe("in-loop"); // back to the Anthropic key
  expect(choice.model.id).toBe("claude-sonnet-4-6");
});

test("an EXPIRED rate window is ignored — a seat whose limit already reset is fresh again", () => {
  putAccount(claudeSeat());
  recordUsage({ accountId: "claude-max", inputTokens: 1, outputTokens: 1, costUSD: 0, estimated: false });
  // A 99%-utilized window, but it reset an hour ago (past) → stale, must NOT penalize.
  recordRateLimits("claude-max", [{ utilization: 0.99, type: "seven_day", resetsAt: Math.floor(Date.now() / 1000) - 3600 }]);
  expect(new RoutingSelector().select({ prompt: "refactor the parser" }).backend?.kind).toBe("cli"); // seat preferred again
});

test("a fresh seat is still preferred (control for the exhaustion test)", () => {
  putAccount(claudeSeat());
  recordUsage({ accountId: "claude-max", inputTokens: 1, outputTokens: 1, costUSD: 0, estimated: false });
  recordRateLimits("claude-max", [{ utilization: 0.1, type: "seven_day", resetsAt: futureSec() }]);
  expect(new RoutingSelector().select({ prompt: "refactor the parser" }).backend?.kind).toBe("cli");
});

test("SubscriptionPinSelector hard-pins the seat regardless of routing", () => {
  putAccount(claudeSeat());
  recordUsage({ accountId: "claude-max", inputTokens: 1, outputTokens: 1, costUSD: 0, estimated: false });
  recordRateLimits("claude-max", [{ utilization: 0.99, type: "seven_day", resetsAt: futureSec() }]);
  // Even exhausted, an explicit pin still runs the seat (the user overrode the optimizer).
  const choice = new SubscriptionPinSelector("claude-max").select({ prompt: "refactor the parser" });
  expect(choice.backend?.kind).toBe("cli");
  expect(choice.reason).toContain("pinned");
});

test("global preference 'api' removes the seat from routing", () => {
  putAccount(claudeSeat());
  const { setGlobalPreference } = require("../src/model/preferences.ts");
  setGlobalPreference({ prefer: "api" });
  expect(new RoutingSelector().select({ prompt: "refactor the parser" }).backend?.kind).toBe("in-loop");
});
