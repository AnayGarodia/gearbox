// Auto-effort routing: pick the effort level that minimizes expected cost for a
// (model, task) — low effort for easy/netted work (cheaper+faster, quality is
// enough), high effort for hard/unnetted work (quality is worth the cost+latency).
// The effort→{cost,latency} effects are mechanically real; the effort→quality
// effect is a small CONSERVATIVE modeled estimate (no public per-effort quality
// data exists), so these tests pin the SHAPE, not fabricated magnitudes.
import { test, expect } from "bun:test";
import { effortEffect, bestEffort, qualityGainFromEffort, EFFORT_QUALITY_MAX, EFFORT_QUALITY_PROVENANCE } from "../src/model/effort.ts";

test("higher effort costs more output and is slower; lower effort is cheaper and faster", () => {
  const low = effortEffect("low");
  const high = effortEffect("high");
  const max = effortEffect("max");
  expect(high.outputFactorMult).toBeGreaterThan(low.outputFactorMult);
  expect(max.outputFactorMult).toBeGreaterThan(high.outputFactorMult);
  expect(high.ttftMult).toBeGreaterThan(low.ttftMult);
});

test("effort's quality help scales with difficulty: a lot on a hard task, ~nothing on an easy one (modeled, bounded)", () => {
  const levels = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
  // monotonic in effort, at a fixed difficulty
  const hard = levels.map((l) => qualityGainFromEffort(l, 1));
  for (let i = 1; i < hard.length; i++) expect(hard[i]!).toBeGreaterThanOrEqual(hard[i - 1]!);
  // on an easy task effort barely helps; on a hard one it helps far more
  expect(qualityGainFromEffort("max", 0)).toBeCloseTo(0, 6);
  expect(qualityGainFromEffort("max", 1)).toBeGreaterThan(qualityGainFromEffort("max", 0.2));
  // bounded — effort TUNES a model, it never transforms a weak one into a strong one
  for (const g of hard) expect(g).toBeLessThanOrEqual(EFFORT_QUALITY_MAX + 1e-9);
  // the quality effect is explicitly labelled estimated, not researched
  expect(EFFORT_QUALITY_PROVENANCE).toBe("estimated");
});

// A capable model whose effort levels are evaluated against a task.
const model = { quality: 0.85, inUSDPerMtok: 3, outUSDPerMtok: 15, tps: 80, ttftMs: 1500, baseOutputFactor: 0.3 };
const levels = ["low", "medium", "high", "xhigh", "max"];

test("easy task with a test net → the router picks a LOW effort (cost+latency dominate)", () => {
  const pick = bestEffort(model, levels, { estInputTokens: 16_000, difficulty: 0, verifierTier: "tests", interactive: true });
  expect(pick.level).toBeDefined();
  expect(["low", "medium"]).toContain(pick.level!);
});

test("hard task with NO net → the router picks a HIGH effort (quality is worth the cost)", () => {
  const pick = bestEffort(model, levels, { estInputTokens: 16_000, difficulty: 1, verifierTier: "none", interactive: false });
  expect(pick.level).toBeDefined();
  expect(["high", "xhigh", "max"]).toContain(pick.level!);
});

test("bestEffort returns a level from the model's own vocabulary, clamped if needed", () => {
  const pick = bestEffort(model, ["low", "high"], { estInputTokens: 16_000, difficulty: 1, verifierTier: "none", interactive: false });
  expect(pick.level).toBeDefined();
  expect(["low", "high"]).toContain(pick.level!);
});

test("a model with no effort vocabulary returns undefined (nothing to route)", () => {
  const pick = bestEffort(model, [], { estInputTokens: 16_000, difficulty: 0, verifierTier: "tests", interactive: false });
  expect(pick.level).toBeUndefined();
});
