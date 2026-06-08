import { test, expect } from "bun:test";
import { differentiatingSlice, longestCommonPrefixLen } from "../src/truncate.ts";

test("longestCommonPrefixLen finds the shared prefix length", () => {
  expect(longestCommonPrefixLen(["abcd", "abce"])).toBe(3);
  expect(longestCommonPrefixLen(["abc", "xyz"])).toBe(0);
  expect(longestCommonPrefixLen(["only one"])).toBe(0);
});

test("differentiatingSlice shows the VARYING tail when siblings share a long prefix", () => {
  const tasks = [
    "You are doing a COMMENT CLEANUP PASS only — no logic in src/agent/run.ts",
    "You are doing a COMMENT CLEANUP PASS only — no logic in src/ui/App.tsx",
    "You are doing a COMMENT CLEANUP PASS only — no logic in src/model/router.ts",
  ];
  const a = differentiatingSlice(tasks, 0, 40);
  const b = differentiatingSlice(tasks, 1, 40);
  expect(a).toContain("run.ts");
  expect(b).toContain("App.tsx");
  expect(a).not.toBe(b); // the whole point: distinguishable
  expect(a).not.toContain("COMMENT CLEANUP"); // shared prefix dropped
});

test("differentiatingSlice falls back to the (clipped) task when siblings are identical", () => {
  const same = ["fix the auth bug", "fix the auth bug"];
  expect(differentiatingSlice(same, 0, 40)).toBe("fix the auth bug");
});

test("a single string just gets word-boundary clipped", () => {
  expect(differentiatingSlice(["short task"], 0, 40)).toBe("short task");
  expect(differentiatingSlice(["a very long task description that keeps going well past the limit"], 0, 20)).toMatch(/…$/);
});
