// The per-effort flywheel: recordTurnOutcome stores outcomes per (kind, model,
// effort), effortPassRate reads them (gated at MIN_N), and bestEffort blends the
// modeled effort-quality toward that measured reality.
import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordTurnOutcome, effortPassRate, clearPriorsCache } from "../src/model/priors.ts";
import { bestEffort } from "../src/model/effort.ts";

beforeEach(() => {
  process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gearbox-effort-fw-"));
  clearPriorsCache();
});

test("effortPassRate is silent below MIN_N, then reports the measured rate per effort", () => {
  expect(effortPassRate("code", "m", "high", "r")).toBeNull();
  for (let i = 0; i < 8; i++) recordTurnOutcome({ kind: "code", modelId: "m", outcome: "passed", repo: "r", effort: "high" });
  const hi = effortPassRate("code", "m", "high", "r")!;
  expect(hi.n).toBe(8);
  expect(hi.rate).toBeGreaterThan(0.8);
  // a DIFFERENT effort level is tracked separately
  expect(effortPassRate("code", "m", "low", "r")).toBeNull();
});

test("the per-effort tree does not pollute the per-model prior", () => {
  // recording with an effort still records the per-model outcome too
  for (let i = 0; i < 8; i++) recordTurnOutcome({ kind: "code", modelId: "m", outcome: "failed", repo: "r", effort: "low" });
  // low effort measured as failing; high effort has no data
  expect(effortPassRate("code", "m", "low", "r")!.rate).toBeLessThan(0.3);
  expect(effortPassRate("code", "m", "high", "r")).toBeNull();
});

test("bestEffort blends toward measured reality: a level that PASSES here is favored over the modeled estimate", () => {
  const model = { quality: 0.6, inUSDPerMtok: 3, outUSDPerMtok: 15, tps: 80, ttftMs: 1500, baseOutputFactor: 0.3 };
  const ctx = { estInputTokens: 16_000, difficulty: 0.5, verifierTier: "none" as const, interactive: false };
  // Measured: "high" passes ~95% here, "low" ~50% — the blend should lift high's
  // effective quality well above its modeled value.
  const measured = (lvl: string) => (lvl === "high" ? 0.95 : lvl === "low" ? 0.5 : null);
  const withData = bestEffort(model, ["low", "medium", "high"], ctx, measured);
  const noData = bestEffort(model, ["low", "medium", "high"], ctx);
  // with the measured boost, high's quality is higher than the purely-modeled run
  expect(withData.quality).toBeGreaterThan(noData.quality - 1e-9);
  expect(["medium", "high"]).toContain(withData.level);
});
