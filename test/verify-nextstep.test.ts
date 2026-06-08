import { test, expect } from "bun:test";
import { nextStepFor, provenTier } from "../src/verify.ts";

// ── honest "done with proof" tiering ──
test("provenTier: tests beat types beat nothing", () => {
  expect(provenTier(["typecheck", "test"])).toBe("tests"); // a green test run is the highest proof
  expect(provenTier(["test"])).toBe("tests");
  expect(provenTier(["typecheck"])).toBe("types"); // types/build/lint only
  expect(provenTier(["build"])).toBe("types");
  expect(provenTier(["lint"])).toBe("types");
  expect(provenTier([])).toBe("none"); // edited but nothing was verified
  expect(provenTier([undefined])).toBe("none");
});

test("a merge-conflict marker → resolve the conflict, never /retry", () => {
  const out = nextStepFor(["bun run typecheck: src/agent/run.ts(174,1): error TS1185: Merge conflict marker encountered."], ["src/foo.ts"]);
  expect(out).toContain("resolve the conflict");
  expect(out).toContain("run.ts");
  expect(out).not.toContain("/retry");
});

test("an error only in files the turn didn't touch → flagged as pre-existing", () => {
  const out = nextStepFor(["bun run typecheck: src/agent/run.ts(174,1): error TS2304"], ["scratch.txt", "notes.md"]);
  expect(out).toContain("predates");
  expect(out).not.toContain("/retry");
});

test("an error in a file the turn DID change → /retry (a real regression)", () => {
  const out = nextStepFor(["src/foo.ts(10,2): error TS2322: Type mismatch"], ["src/foo.ts"]);
  expect(out).toBe("/retry");
});

test("no failures → a forward action, not /retry", () => {
  expect(nextStepFor([], ["src/foo.ts"])).toBe("commit changes");
  expect(nextStepFor([], [])).toBe("/context");
});
