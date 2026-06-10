// The routing flywheel: verification outcomes become measured per-repo priors.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordTurnOutcome, priorFor, priorLine, clearPriorsCache } from "../src/model/priors.ts";
import { RoutingSelector } from "../src/model/router.ts";
import { clearCooldowns } from "../src/model/cooldown.ts";

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ["ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "GEARBOX_HOME"]) saved[k] = process.env[k];
  process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gearbox-priors-"));
  process.env.ANTHROPIC_API_KEY = "k";
  process.env.DEEPSEEK_API_KEY = "k";
  clearPriorsCache();
  clearCooldowns();
});
afterEach(() => {
  for (const k of ["ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "GEARBOX_HOME"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  clearPriorsCache();
});

test("a prior stays silent below 4 verified outcomes (opinion is not evidence)", () => {
  recordTurnOutcome({ kind: "code", modelId: "m", outcome: "failed", repo: "r" });
  recordTurnOutcome({ kind: "code", modelId: "m", outcome: "failed", repo: "r" });
  recordTurnOutcome({ kind: "code", modelId: "m", outcome: "failed", repo: "r" });
  expect(priorFor("code", "m", "r")).toBeNull();
  recordTurnOutcome({ kind: "code", modelId: "m", outcome: "failed", repo: "r" });
  expect(priorFor("code", "m", "r")).not.toBeNull();
});

test("persistent failures pull quality DOWN; passes push it up only slightly", () => {
  for (let i = 0; i < 6; i++) recordTurnOutcome({ kind: "code", modelId: "bad", outcome: "failed", repo: "r" });
  for (let i = 0; i < 8; i++) recordTurnOutcome({ kind: "code", modelId: "good", outcome: "passed", repo: "r" });
  const bad = priorFor("code", "bad", "r")!;
  const good = priorFor("code", "good", "r")!;
  expect(bad.delta).toBeLessThan(-0.1); // enough to sink below a 0.7 bar
  expect(good.delta).toBeGreaterThan(0);
  expect(good.delta).toBeLessThanOrEqual(0.04); // asymmetric on purpose
});

test("an /undo counts double — a human revert is the costliest outcome", () => {
  for (let i = 0; i < 3; i++) recordTurnOutcome({ kind: "code", modelId: "m", outcome: "passed", repo: "r" });
  recordTurnOutcome({ kind: "code", modelId: "m", outcome: "undone", repo: "r" });
  const withUndo = priorFor("code", "m", "r")!;
  clearPriorsCache();
  process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gearbox-priors2-"));
  for (let i = 0; i < 3; i++) recordTurnOutcome({ kind: "code", modelId: "m", outcome: "passed", repo: "r" });
  recordTurnOutcome({ kind: "code", modelId: "m", outcome: "failed", repo: "r" });
  const withFail = priorFor("code", "m", "r")!;
  expect(withUndo.passRate).toBeLessThan(withFail.passRate);
});

test("priors are scoped per repo and per kind", () => {
  for (let i = 0; i < 5; i++) recordTurnOutcome({ kind: "code", modelId: "m", outcome: "failed", repo: "repo-a" });
  expect(priorFor("code", "m", "repo-a")).not.toBeNull();
  expect(priorFor("code", "m", "repo-b")).toBeNull();
  expect(priorFor("summarize", "m", "repo-a")).toBeNull();
});

test("priorLine renders the /why note", () => {
  for (let i = 0; i < 4; i++) recordTurnOutcome({ kind: "code", modelId: "m", outcome: "passed", repo: "r" });
  expect(priorLine("code", "m", "r")).toContain("measured here");
  expect(priorLine("code", "nope", "r")).toBeNull();
});

test("ROUTER: a model that keeps failing verification HERE stops being routed here", () => {
  // deepseek-v4-pro normally wins code (cheapest clearing the 0.7 bar).
  const r = new RoutingSelector();
  const task = { prompt: "refactor the parser", kind: "code" as const };
  expect(r.select(task).model.id).toBe("deepseek-v4-pro");
  // Six failed verifications in THIS repo sink it below the bar → routing
  // climbs to the next candidate without any cooldown or error.
  const repo = process.cwd().replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root";
  for (let i = 0; i < 6; i++) recordTurnOutcome({ kind: "code", modelId: "deepseek-v4-pro", outcome: "failed", repo });
  clearPriorsCache();
  const after = r.select(task);
  expect(after.model.id).not.toBe("deepseek-v4-pro");
});
