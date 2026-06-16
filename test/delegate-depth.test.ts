// Step 10: delegation nesting depth is configurable but hard-capped. Default 1
// (only the top-level turn delegates — the original no-recursion invariant);
// GEARBOX_MAX_DELEGATE_DEPTH=2 enables depth-2 nesting; anything higher is clamped
// so a runaway fan-out tree is impossible.
import { test, expect, afterEach } from "bun:test";
import { maxDelegateDepth, DELEGATE_DEPTH_CAP } from "../src/agent/run.ts";

const saved = process.env.GEARBOX_MAX_DELEGATE_DEPTH;
afterEach(() => {
  if (saved === undefined) delete process.env.GEARBOX_MAX_DELEGATE_DEPTH;
  else process.env.GEARBOX_MAX_DELEGATE_DEPTH = saved;
});

test("default is 1 — only depth 0 delegates, sub-agents cannot (no recursion)", () => {
  delete process.env.GEARBOX_MAX_DELEGATE_DEPTH;
  expect(maxDelegateDepth()).toBe(1);
});

test("=2 enables depth-2 nesting (a sub-agent may delegate once more)", () => {
  process.env.GEARBOX_MAX_DELEGATE_DEPTH = "2";
  expect(maxDelegateDepth()).toBe(2);
});

test("over the cap is clamped to the hard maximum", () => {
  process.env.GEARBOX_MAX_DELEGATE_DEPTH = "9";
  expect(maxDelegateDepth()).toBe(DELEGATE_DEPTH_CAP);
  expect(DELEGATE_DEPTH_CAP).toBe(2);
});

test("invalid / sub-1 values fall back to the safe default of 1", () => {
  for (const v of ["0", "-3", "abc", "", "1.5"]) {
    process.env.GEARBOX_MAX_DELEGATE_DEPTH = v;
    // "1.5" floors to 1; the rest are invalid/too-low → 1.
    expect(maxDelegateDepth()).toBe(1);
  }
});
