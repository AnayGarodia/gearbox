import { test, expect, describe } from "bun:test";
import { shouldAutoFix, buildFixPrompt, MAX_AUTOFIX_ATTEMPTS } from "../src/verify.ts";

describe("shouldAutoFix", () => {
  const base = { mode: "auto" as const, attempt: 0, failures: ["test: 1 failing"], changedFiles: ["src/a.ts"] };

  test("fixes when mode is auto, there are failures, and attempts remain", () => {
    expect(shouldAutoFix(base)).toBe(true);
  });

  test("never fixes when mode is off", () => {
    expect(shouldAutoFix({ ...base, mode: "off" })).toBe(false);
  });

  test("does not fix when there are no failures", () => {
    expect(shouldAutoFix({ ...base, failures: [] })).toBe(false);
  });

  test("stops after the attempt budget is exhausted", () => {
    expect(shouldAutoFix({ ...base, attempt: MAX_AUTOFIX_ATTEMPTS })).toBe(false);
  });

  test("does not auto-fix a failure that predates the change (no changed files)", () => {
    // Nothing was edited this turn, so a failing check is not ours to chase.
    expect(shouldAutoFix({ ...base, changedFiles: [] })).toBe(false);
  });
});

describe("buildFixPrompt", () => {
  test("includes the failing check output and asks for a fix", () => {
    const p = buildFixPrompt(["typecheck: TS2345 bad arg", "test: 2 failing"]);
    expect(p).toContain("TS2345 bad arg");
    expect(p).toContain("2 failing");
    expect(p.toLowerCase()).toContain("fix");
  });

  test("is non-empty even with a single failure", () => {
    expect(buildFixPrompt(["build: error"]).length).toBeGreaterThan(0);
  });
});
