import { test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoutingSelector, SubscriptionPinSelector } from "../src/model/router.ts";
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

function claudeSeat(): Account {
  return {
    id: "claude-max", label: "Claude Max", provider: "claude-cli", exec: "cli",
    auth: { kind: "cli", binary: "claude" }, models: ["claude-sonnet-4-6"],
    enabled: true, addedAt: 0,
  };
}

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
  recordRateLimits("claude-max", [{ utilization: 0.99, type: "seven_day", resetsAt: 9_999 }]);
  const choice = new RoutingSelector().select({ prompt: "refactor the parser" });
  expect(choice.backend?.kind).toBe("in-loop"); // back to the Anthropic key
  expect(choice.model.id).toBe("claude-sonnet-4-6");
});

test("a fresh seat is still preferred (control for the exhaustion test)", () => {
  putAccount(claudeSeat());
  recordUsage({ accountId: "claude-max", inputTokens: 1, outputTokens: 1, costUSD: 0, estimated: false });
  recordRateLimits("claude-max", [{ utilization: 0.1, type: "seven_day", resetsAt: 9_999 }]);
  expect(new RoutingSelector().select({ prompt: "refactor the parser" }).backend?.kind).toBe("cli");
});

test("SubscriptionPinSelector hard-pins the seat regardless of routing", () => {
  putAccount(claudeSeat());
  recordUsage({ accountId: "claude-max", inputTokens: 1, outputTokens: 1, costUSD: 0, estimated: false });
  recordRateLimits("claude-max", [{ utilization: 0.99, type: "seven_day", resetsAt: 9_999 }]);
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
