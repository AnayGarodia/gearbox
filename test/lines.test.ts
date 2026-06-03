import { test, expect } from "bun:test";
import { wrapSpans, itemsToLines } from "../src/ui/lines.ts";
import type { Item } from "../src/ui/types.ts";

const lineLen = (line: { text: string }[]) => line.reduce((n, s) => n + s.text.length, 0);

test("wrapSpans never exceeds the width and keeps all words", () => {
  const text = "the quick brown fox jumps over the lazy dog again and again";
  const lines = wrapSpans([{ text }], 20);
  for (const l of lines) expect(lineLen(l)).toBeLessThanOrEqual(20);
  expect(lines.map((l) => l.map((s) => s.text).join("")).join(" ")).toContain("quick brown fox");
});

test("wrapSpans hard-breaks a word longer than the width", () => {
  const lines = wrapSpans([{ text: "x".repeat(50) }], 10);
  expect(lines.length).toBeGreaterThanOrEqual(5);
  for (const l of lines) expect(lineLen(l)).toBeLessThanOrEqual(10);
});

test("itemsToLines keeps every line within the width (no overflow → no corruption)", () => {
  const W = 40;
  const items: Item[] = [
    { kind: "user", id: 1, text: "please refactor the entire authentication subsystem and explain each step thoroughly" },
    { kind: "assistant", id: 2, text: "Sure. Here is **a long** explanation with a `codeSpan` and a fenced block:\n\n```\nconst reallyLongIdentifierThatExceedsTheLineWidthForSure = 1\n```\n\nDone.", done: true },
    { kind: "tool", id: 3, callId: "a", name: "run", arg: "bun test --coverage --reporter=verbose", status: "ok", summary: "26 passed" },
    { kind: "notice", id: 4, text: "a multi\nline\nnotice output that simulates cat of a file with several lines" },
  ];
  const lines = itemsToLines(items, W);
  expect(lines.length).toBeGreaterThan(0);
  for (const l of lines) expect(lineLen(l)).toBeLessThanOrEqual(W);
});

test("a multi-line notice becomes multiple lines", () => {
  const lines = itemsToLines([{ kind: "notice", id: 1, text: "one\ntwo\nthree" }], 60);
  // 1 leading blank + 3 content lines
  expect(lines.length).toBeGreaterThanOrEqual(4);
});
