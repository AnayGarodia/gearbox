import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoutingSelector } from "../src/model/router.ts";
import { markExhausted, clearCooldowns, DEFAULT_COOLDOWN_MS } from "../src/model/cooldown.ts";

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

  // Normally deepseek wins (cheapest clearing the bar).
  const first = r.select(task);
  expect(first.model.id).toBe("deepseek-v4-pro");

  // Park deepseek's env key (what the runner does on its 429) → next pick differs.
  markExhausted("env:deepseek", DEFAULT_COOLDOWN_MS, "429 rate limit");
  const failedOver = r.select(task);
  expect(failedOver.model.provider).not.toBe("deepseek");
  expect(failedOver.model.id).toBe("claude-sonnet-4-6"); // cheapest remaining that clears the bar

  // It is a skip, not a permanent ban: routing is unaffected after it would expire.
  // (clearCooldowns simulates the window resetting.)
  clearCooldowns();
  expect(r.select(task).model.id).toBe("deepseek-v4-pro");
});

test("when the cooled account is the ONLY option, routing relaxes rather than dead-ending", () => {
  delete process.env.DEEPSEEK_API_KEY; // anthropic only
  const r = new RoutingSelector();
  markExhausted("env:anthropic", DEFAULT_COOLDOWN_MS, "429");
  // Every candidate is cooled, but we must still return a usable model, not throw.
  expect(() => r.select({ prompt: "refactor the parser" })).not.toThrow();
});
