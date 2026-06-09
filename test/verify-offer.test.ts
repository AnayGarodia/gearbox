// The characterization-test offer: fires once, only for clean code-changing
// turns in projects whose checks can't prove behavior (no test command).
import { test, expect } from "bun:test";
import { hasTestCheck, shouldOfferCharTest, buildCharTestPrompt, type VerificationCommand } from "../src/verify.ts";

const cmd = (command: string): VerificationCommand => ({ command, reason: "test fixture" });
const base = {
  mode: "auto" as const,
  hadError: false,
  changedFiles: ["src/x.ts"],
  commands: [] as VerificationCommand[],
  alreadyOffered: false,
  optedOut: false,
};

test("hasTestCheck: only a real test runner counts", () => {
  expect(hasTestCheck([])).toBe(false);
  expect(hasTestCheck([cmd("bun run build"), cmd("bun run typecheck")])).toBe(false);
  expect(hasTestCheck([cmd("bun test")])).toBe(true);
  expect(hasTestCheck([cmd("pytest")])).toBe(true);
  expect(hasTestCheck([cmd("cargo test")])).toBe(true);
});

test("offers when no commands exist, and when only build/typecheck exist", () => {
  expect(shouldOfferCharTest(base)).toBe(true);
  expect(shouldOfferCharTest({ ...base, commands: [cmd("npm run build")] })).toBe(true);
  expect(shouldOfferCharTest({ ...base, commands: [cmd("bun run typecheck"), cmd("bun run build")] })).toBe(true);
});

test("never offers when a test command exists", () => {
  expect(shouldOfferCharTest({ ...base, commands: [cmd("bun test")] })).toBe(false);
});

test("never offers when off / errored / already offered / opted out", () => {
  expect(shouldOfferCharTest({ ...base, mode: "off" })).toBe(false);
  expect(shouldOfferCharTest({ ...base, hadError: true })).toBe(false);
  expect(shouldOfferCharTest({ ...base, alreadyOffered: true })).toBe(false);
  expect(shouldOfferCharTest({ ...base, optedOut: true })).toBe(false);
});

test("doc-only turns never trigger it", () => {
  expect(shouldOfferCharTest({ ...base, changedFiles: ["README.md", "docs/a.md"] })).toBe(false);
  expect(shouldOfferCharTest({ ...base, changedFiles: ["README.md", "src/y.py"] })).toBe(true);
});

test("buildCharTestPrompt: lists the files and sets the capture-don't-judge rules", () => {
  const p = buildCharTestPrompt(["src/a.ts", "src/b.ts"]);
  expect(p).toContain("src/a.ts");
  expect(p).toContain("src/b.ts");
  expect(p).toContain("CHARACTERIZATION");
  expect(p).toContain("CURRENT behavior");
  expect(p).toContain("Do not fix or judge");
  expect(p).toContain("timestamps");
  expect(p).toContain("RUN the test");
});
