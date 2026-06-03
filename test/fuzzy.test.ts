import { test, expect } from "bun:test";
import { fuzzyScore, fuzzyRank } from "../src/ui/fuzzy.ts";

test("fuzzyScore matches subsequences, rejects non-subsequences", () => {
  expect(fuzzyScore("abc", "aXbXc")).not.toBeNull();
  expect(fuzzyScore("abc", "acb")).toBeNull(); // out of order
  expect(fuzzyScore("", "anything")).toBe(0);
});

test("fuzzyRank ranks boundary + contiguous matches higher", () => {
  const files = ["src/ui/theme.ts", "src/ui/types.ts", "test/theme.snapshot.ts", "src/agent/run.ts"];
  const r = fuzzyRank(files, "theme", (f) => f);
  expect(r[0]).toBe("src/ui/theme.ts"); // contiguous "theme" at a path boundary wins
  expect(r).not.toContain("src/agent/run.ts"); // no subsequence
});

test("fuzzyRank finds path matches across separators", () => {
  const files = ["src/ui/components/StatusBar.tsx", "src/ui/input.ts", "README.md"];
  const r = fuzzyRank(files, "uistatus", (f) => f);
  expect(r[0]).toBe("src/ui/components/StatusBar.tsx");
});

test("fuzzyRank respects the limit", () => {
  const items = Array.from({ length: 50 }, (_, i) => `file_${i}.ts`);
  expect(fuzzyRank(items, "file", (f) => f, 5).length).toBe(5);
});
