import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoutingSelector } from "../src/model/router.ts";
import { markExhausted, modelScopedKey, clearCooldowns, DEFAULT_COOLDOWN_MS } from "../src/model/cooldown.ts";

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ["ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "GEARBOX_HOME"]) saved[k] = process.env[k];
  process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gearbox-failover-"));
  process.env.ANTHROPIC_API_KEY = "k";
  process.env.DEEPSEEK_API_KEY = "k";
  clearCooldowns();
});
afterEach(() => {
  clearCooldowns();
  for (const k of ["ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "GEARBOX_HOME"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

// The reactive-failover mechanism at the routing layer: a re-select after an
// account is parked must route AROUND it. (The runner drives the retry; this is
// the seam it relies on.)
test("re-select routes around a cooled-down account, then back once it expires", () => {
  const r = new RoutingSelector();
  const task = { prompt: "refactor the parser" };

  // Normally deepseek-v4-flash wins (cheapest capable, cheap-first under a net).
  const first = r.select(task);
  expect(first.model.id).toBe("deepseek-v4-flash");

  // Park deepseek's env key (what the runner does on its 429) → next pick differs.
  markExhausted("env:deepseek", DEFAULT_COOLDOWN_MS, "429 rate limit");
  const failedOver = r.select(task);
  expect(failedOver.model.provider).not.toBe("deepseek");
  expect(failedOver.model.id).toBe("claude-haiku-4-5"); // cheapest remaining capable model

  // It is a skip, not a permanent ban: routing is unaffected after it would expire.
  // (clearCooldowns simulates the window resetting.)
  clearCooldowns();
  expect(r.select(task).model.id).toBe("deepseek-v4-flash");
});

// R-5: a rate-limit on ONE model must not bench the account's other models.
test("a model-scoped park skips only that model — siblings on the same key still route", () => {
  delete process.env.DEEPSEEK_API_KEY; // anthropic only, several models on one key
  const r = new RoutingSelector();
  const task = { prompt: "refactor the parser" };

  const first = r.select(task);
  // Park ONLY the winning model on this env key (what the runner does for a 429).
  markExhausted(modelScopedKey("env:anthropic", first.model.id), DEFAULT_COOLDOWN_MS, "429 rate limit");
  const next = r.select(task);
  // Same provider key stays usable — a different anthropic model wins instead.
  expect(next.model.provider).toBe("anthropic");
  expect(next.model.id).not.toBe(first.model.id);
});

test("when the cooled account is the ONLY option, routing relaxes rather than dead-ending", () => {
  delete process.env.DEEPSEEK_API_KEY; // anthropic only
  const r = new RoutingSelector();
  markExhausted("env:anthropic", DEFAULT_COOLDOWN_MS, "429");
  // Every candidate is cooled, but we must still return a usable model, not throw.
  expect(() => r.select({ prompt: "refactor the parser" })).not.toThrow();
});
