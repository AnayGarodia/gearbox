import { test, expect, describe } from "bun:test";
import { shouldAutoFix, buildFixPrompt, buildAutofixCaveat, MAX_AUTOFIX_ATTEMPTS } from "../src/verify.ts";

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

describe("buildAutofixCaveat", () => {
  test("returns null on the original turn (attempt 0)", () => {
    expect(buildAutofixCaveat(0, [], ["src/a.ts"])).toBeNull();
  });

  test("returns null when checks still failing", () => {
    expect(buildAutofixCaveat(1, ["test: 2 failing"], ["src/a.ts"])).toBeNull();
  });

  test("returns null when no files changed", () => {
    expect(buildAutofixCaveat(1, [], [])).toBeNull();
  });

  test("returns caveat string when autofix succeeded", () => {
    const c = buildAutofixCaveat(1, [], ["src/a.ts"]);
    expect(c).not.toBeNull();
    expect(c).toContain("tests confirm structure");
    expect(c).toContain("1 autofix attempt");
  });

  test("pluralizes correctly for multiple attempts", () => {
    expect(buildAutofixCaveat(2, [], ["src/a.ts"])).toContain("2 autofix attempts");
  });
});

// ── Same-failure early stop ──────────────────────────────────────────────────
import { failureFingerprint } from "../src/verify.ts";

test("failureFingerprint normalizes whitespace and order but keeps counts", () => {
  expect(failureFingerprint(["a  failed\n", " a failed"])).toBe(failureFingerprint(["a failed", "a failed"]));
  expect(failureFingerprint(["b failed", "a failed"])).toBe(failureFingerprint(["a failed", "b failed"]));
  // progress (different counts) must change the fingerprint
  expect(failureFingerprint(["3 tests failed"])).not.toBe(failureFingerprint(["2 tests failed"]));
});

test("identical consecutive failure stops the auto-fix loop early", () => {
  const base = { mode: "auto" as const, changedFiles: ["a.ts"], failures: ["bun test: x is not defined"] };
  const fp = failureFingerprint(base.failures);
  // attempt 1 with a DIFFERENT previous failure → keep going
  expect(shouldAutoFix({ ...base, attempt: 1, prevFingerprint: failureFingerprint(["other"]) })).toBe(true);
  // attempt 1 reproducing the SAME failure → stop, despite budget remaining
  expect(shouldAutoFix({ ...base, attempt: 1, prevFingerprint: fp })).toBe(false);
  // no previous fingerprint (first attempt) → unaffected
  expect(shouldAutoFix({ ...base, attempt: 1 })).toBe(true);
});

test("failureFingerprint strips run-variable tokens (durations, addresses, tmp paths)", () => {
  // bun/vitest-style duration in the fail line must not read as progress
  expect(failureFingerprint(['error: expect(received).toBe(expected) [12.43ms]'])).toBe(failureFingerprint(['error: expect(received).toBe(expected) [9.01ms]']));
  expect(failureFingerprint(["Ran all test suites in 3.2s"])).toBe(failureFingerprint(["Ran all test suites in 4.7s"]));
  // panic addresses
  expect(failureFingerprint(["panicked at 0x7f3a91b2"])).toBe(failureFingerprint(["panicked at 0x7f000001"]));
  // tmp paths
  expect(failureFingerprint(["ENOENT /var/folders/xx/T/build-1234/out"])).toBe(failureFingerprint(["ENOENT /var/folders/yy/T/build-9999/out"]));
  // counts and line numbers survive the stripping
  expect(failureFingerprint(["3 tests failed at a.ts:42"])).not.toBe(failureFingerprint(["2 tests failed at a.ts:42"]));
  expect(failureFingerprint(["fail at a.ts:42"])).not.toBe(failureFingerprint(["fail at a.ts:43"]));
});
