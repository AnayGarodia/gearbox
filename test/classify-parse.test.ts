// The classifier's reply parser: a cheap model returns a category and (for
// code/plan) a difficulty band, in either order, possibly wrapped in noise. The
// parse must be order-independent and robust to junk, returning what it found.
import { test, expect } from "bun:test";
import { parseClassification } from "../src/agent/classify.ts";

test("parses a bare category", () => {
  expect(parseClassification("code")).toEqual({ kind: "code", band: undefined });
  expect(parseClassification("chat")).toEqual({ kind: "chat", band: undefined });
});

test("parses category + difficulty band, order-independent", () => {
  expect(parseClassification("code hard")).toEqual({ kind: "code", band: "hard" });
  expect(parseClassification("hard code")).toEqual({ kind: "code", band: "hard" });
  expect(parseClassification("plan medium")).toEqual({ kind: "plan", band: "medium" });
});

test("survives noise around the words", () => {
  expect(parseClassification("Category: code, difficulty: hard.")).toEqual({ kind: "code", band: "hard" });
  expect(parseClassification("  EASY   code  ")).toEqual({ kind: "code", band: "easy" });
});

test("returns undefined fields when nothing matches", () => {
  expect(parseClassification("foobar")).toEqual({ kind: undefined, band: undefined });
  expect(parseClassification("")).toEqual({ kind: undefined, band: undefined });
});

test("a band on a non-code kind is still parsed (caller decides relevance)", () => {
  expect(parseClassification("chat easy")).toEqual({ kind: "chat", band: "easy" });
});
