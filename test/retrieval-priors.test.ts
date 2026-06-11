import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRetrievalPriors, recordRetrievalUse, resetRetrievalPriorsForTest, retrievalPriorScore } from "../src/context/retrieval-priors.ts";

let home = "";
beforeEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = mkdtempSync(join(tmpdir(), "gearbox-priors-"));
  process.env.GEARBOX_HOME = home;
  resetRetrievalPriorsForTest();
});

test("recordRetrievalUse boosts files that were injected and used", () => {
  const cwd = "/repo/a";
  recordRetrievalUse({ injected: ["src/a.ts"], used: ["src/a.ts"], unused: [] }, cwd, 1);
  const prior = loadRetrievalPriors(cwd)["src/a.ts"]!;
  expect(prior.injected).toBe(1);
  expect(prior.used).toBe(1);
  expect(prior.score).toBeGreaterThan(0);
  expect(retrievalPriorScore("src/a.ts", cwd)).toBe(prior.score);
});

test("recordRetrievalUse penalizes repeated unused injections", () => {
  const cwd = "/repo/b";
  for (let i = 0; i < 4; i++) {
    recordRetrievalUse({ injected: ["src/noise.ts"], used: [], unused: ["src/noise.ts"] }, cwd, i);
  }
  const prior = loadRetrievalPriors(cwd)["src/noise.ts"]!;
  expect(prior.injected).toBe(4);
  expect(prior.unused).toBe(4);
  expect(prior.score).toBeLessThan(0);
});

test("priors are scoped per repo", () => {
  recordRetrievalUse({ injected: ["src/a.ts"], used: ["src/a.ts"], unused: [] }, "/repo/a", 1);
  expect(retrievalPriorScore("src/a.ts", "/repo/a")).toBeGreaterThan(0);
  expect(retrievalPriorScore("src/a.ts", "/repo/b")).toBe(0);
});
