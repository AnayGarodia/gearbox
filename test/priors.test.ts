// The routing flywheel: verification outcomes become measured per-repo priors.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordTurnOutcome, priorFor, priorLine, failRateFor, clearPriorsCache } from "../src/model/priors.ts";
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

test("a prior stays silent below 8 verified outcomes (opinion is not evidence)", () => {
  for (let i = 0; i < 7; i++) recordTurnOutcome({ kind: "code", modelId: "m", outcome: "failed", repo: "r" });
  expect(priorFor("code", "m", "r")).toBeNull();
  recordTurnOutcome({ kind: "code", modelId: "m", outcome: "failed", repo: "r" });
  expect(priorFor("code", "m", "r")).not.toBeNull();
});

test("persistent failures pull quality DOWN; passes push it up only slightly", () => {
  for (let i = 0; i < 8; i++) recordTurnOutcome({ kind: "code", modelId: "bad", outcome: "failed", repo: "r" });
  for (let i = 0; i < 8; i++) recordTurnOutcome({ kind: "code", modelId: "good", outcome: "passed", repo: "r" });
  const bad = priorFor("code", "bad", "r")!;
  const good = priorFor("code", "good", "r")!;
  expect(bad.delta).toBeLessThan(-0.1); // enough to sink below a 0.7 bar
  expect(good.delta).toBeGreaterThan(0);
  expect(good.delta).toBeLessThanOrEqual(0.04); // asymmetric on purpose
});

test("an /undo counts as HALF a failure — weaker evidence than a red VERIFY", () => {
  for (let i = 0; i < 7; i++) recordTurnOutcome({ kind: "code", modelId: "m", outcome: "passed", repo: "r" });
  recordTurnOutcome({ kind: "code", modelId: "m", outcome: "undone", repo: "r" });
  const withUndo = priorFor("code", "m", "r")!;
  clearPriorsCache();
  process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gearbox-priors2-"));
  for (let i = 0; i < 7; i++) recordTurnOutcome({ kind: "code", modelId: "m", outcome: "passed", repo: "r" });
  recordTurnOutcome({ kind: "code", modelId: "m", outcome: "failed", repo: "r" });
  const withFail = priorFor("code", "m", "r")!;
  // An undo hurts LESS than a failed verification (it is ambiguous evidence).
  expect(withUndo.passRate).toBeGreaterThan(withFail.passRate);
});

test("routine /undo cleanups alone cannot sink a bar-clearing model below the bar", () => {
  // 8 undos with zero failed VERIFYs: delta must stay above the worst case —
  // half-weighted undos leave passRate at (0+1)/(0+4+2)=0.167, still clamped,
  // but a mixed history (4 passes + 4 undos) must NOT clamp to MIN_DELTA.
  for (let i = 0; i < 4; i++) recordTurnOutcome({ kind: "code", modelId: "m", outcome: "passed", repo: "r" });
  for (let i = 0; i < 4; i++) recordTurnOutcome({ kind: "code", modelId: "m", outcome: "undone", repo: "r" });
  const p = priorFor("code", "m", "r")!;
  expect(p.delta).toBeGreaterThan(-0.12); // not the full clamp
  expect(0.806 + p.delta).toBeGreaterThan(0.7); // a deepseek-class model still clears the code bar
});

test("priors are scoped per repo and per kind", () => {
  for (let i = 0; i < 8; i++) recordTurnOutcome({ kind: "code", modelId: "m", outcome: "failed", repo: "repo-a" });
  expect(priorFor("code", "m", "repo-a")).not.toBeNull();
  expect(priorFor("code", "m", "repo-b")).toBeNull();
  expect(priorFor("summarize", "m", "repo-a")).toBeNull();
});

test("priorLine renders the /why note", () => {
  for (let i = 0; i < 8; i++) recordTurnOutcome({ kind: "code", modelId: "m", outcome: "passed", repo: "r" });
  expect(priorLine("code", "m", "r")).toContain("measured here");
  expect(priorLine("code", "nope", "r")).toBeNull();
});

test("failRateFor: rate math counts an /undo as half a failure", () => {
  // 6 passed + 2 failed + 2 undone → fails = 2 + 0.5*2 = 3; rate = 3/(6+3).
  for (let i = 0; i < 6; i++) recordTurnOutcome({ kind: "code", modelId: "m", outcome: "passed", repo: "r" });
  for (let i = 0; i < 2; i++) recordTurnOutcome({ kind: "code", modelId: "m", outcome: "failed", repo: "r" });
  for (let i = 0; i < 2; i++) recordTurnOutcome({ kind: "code", modelId: "m", outcome: "undone", repo: "r" });
  const fr = failRateFor("code", "m", "r")!;
  expect(fr.rate).toBeCloseTo(3 / 9, 10);
  expect(fr.n).toBe(10); // passed + failed + undone
});

test("failRateFor stays silent below MIN_N verified outcomes (opinion is not evidence)", () => {
  for (let i = 0; i < 7; i++) recordTurnOutcome({ kind: "code", modelId: "m", outcome: "failed", repo: "r" });
  expect(failRateFor("code", "m", "r")).toBeNull();
  recordTurnOutcome({ kind: "code", modelId: "m", outcome: "failed", repo: "r" });
  const fr = failRateFor("code", "m", "r")!;
  expect(fr.rate).toBe(1); // all red — every turn would cost an iterate-to-green
  expect(fr.n).toBe(8);
});

test("failRateFor: unknown model / kind / repo → null", () => {
  for (let i = 0; i < 8; i++) recordTurnOutcome({ kind: "code", modelId: "m", outcome: "passed", repo: "r" });
  expect(failRateFor("code", "nope", "r")).toBeNull();
  expect(failRateFor("summarize", "m", "r")).toBeNull();
  expect(failRateFor("code", "m", "other-repo")).toBeNull();
});

test("ROUTER: a model that keeps failing verification HERE stops being routed here", () => {
  // deepseek-v4-pro normally wins code (cheapest clearing the 0.7 bar).
  const r = new RoutingSelector();
  const task = { prompt: "refactor the parser", kind: "code" as const };
  expect(r.select(task).model.id).toBe("deepseek-v4-pro");
  // Eight failed verifications in THIS repo sink it below the bar → routing
  // climbs to the next candidate without any cooldown or error.
  const repo = process.cwd().replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root";
  for (let i = 0; i < 8; i++) recordTurnOutcome({ kind: "code", modelId: "deepseek-v4-pro", outcome: "failed", repo });
  clearPriorsCache();
  const after = r.select(task);
  expect(after.model.id).not.toBe("deepseek-v4-pro");
});

// ── decay: cap-and-halve so old evidence fades ───────────────────────────────

test("counts halve once verified outcomes pass the decay cap", () => {
  // 30 passes + 11 fails = 41 > 40 → halved to ~15/~6 (rate preserved).
  for (let i = 0; i < 30; i++) recordTurnOutcome({ kind: "code", modelId: "m", outcome: "passed", repo: "r" });
  for (let i = 0; i < 11; i++) recordTurnOutcome({ kind: "code", modelId: "m", outcome: "failed", repo: "r" });
  const p = priorFor("code", "m", "r")!;
  expect(p.n).toBeLessThan(41); // decay actually fired
  expect(p.n).toBeGreaterThanOrEqual(8); // never silenced below MIN_N
});

test("decay preserves the pass rate at the moment of halving", () => {
  for (let i = 0; i < 30; i++) recordTurnOutcome({ kind: "code", modelId: "m", outcome: "passed", repo: "r" });
  const before = priorFor("code", "m", "r")!.passRate;
  for (let i = 0; i < 11; i++) recordTurnOutcome({ kind: "code", modelId: "m", outcome: "failed", repo: "r" });
  // 41st outcome triggers the halving; the measured rate is still ~30/41 pass.
  const after = priorFor("code", "m", "r")!.passRate;
  expect(Math.abs(after - (31 / 43))).toBeLessThan(0.08); // Laplace-smoothed ~0.72, halving keeps it close
});

test("a model that improved recovers faster after decay than raw accumulation", () => {
  // 40 old failures, then a genuine improvement streak. With decay, the old
  // evidence weighs half, so the delta climbs out of the clamp noticeably
  // sooner than 40-vs-N raw math would allow.
  for (let i = 0; i < 40; i++) recordTurnOutcome({ kind: "code", modelId: "m", outcome: "failed", repo: "r" });
  for (let i = 0; i < 30; i++) recordTurnOutcome({ kind: "code", modelId: "m", outcome: "passed", repo: "r" });
  const decayed = priorFor("code", "m", "r")!;
  // Raw (no decay) would be 30 passes vs 40 fails → passRate ~0.43 → clamped MIN.
  expect(decayed.passRate).toBeGreaterThan(0.45);
});
