import { test, expect } from "bun:test";
import { computeDiff, diffStat } from "../src/diff.ts";

test("computeDiff yields only added/removed lines", () => {
  const d = computeDiff("a\nb\nc\n", "a\nB\nc\n");
  expect(d.length).toBe(2);
  expect(d).toContainEqual({ sign: "-", text: "b" });
  expect(d).toContainEqual({ sign: "+", text: "B" });
});

test("computeDiff on identical content is empty", () => {
  expect(computeDiff("x\ny\n", "x\ny\n")).toEqual([]);
});

test("diffStat counts adds and removes", () => {
  expect(diffStat([{ sign: "+", text: "x" }, { sign: "+", text: "y" }, { sign: "-", text: "z" }])).toBe("+2 −1");
});
