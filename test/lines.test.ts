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

test("fullscreen line buffer formats unfenced source as code", () => {
  const source = [
    "from dataclasses import dataclass",
    "from random import Random",
    "",
    "@dataclass(frozen=True)",
    "class Task:",
    "    name: str",
    "    effort: int",
  ].join("\n");
  const lines = itemsToLines([{ kind: "assistant", id: 1, text: source, done: true }], 80);
  const text = lines.map((l) => l.map((s) => s.text).join("")).join("\n");

  expect(text).toContain("python");
  expect(text).toContain("1 │ from dataclasses import dataclass");
  expect(text).toContain("class Task:");
  for (const l of lines) expect(lineLen(l)).toBeLessThanOrEqual(80);
});

test("diff output paints added and removed rows with full-line backgrounds", () => {
  const lines = itemsToLines([
    {
      kind: "tool",
      id: 1,
      callId: "a",
      name: "edit_file",
      arg: "src/example.ts",
      status: "ok",
      summary: "updated src/example.ts",
      diff: [
        { sign: "-", text: "const oldValue = 1;" },
        { sign: "+", text: "const newValue = compute(2);" },
      ],
    },
  ], 72, true);
  const diffRows = lines.filter((l) => l.some((s) => s.text.includes("oldValue") || s.text.includes("newValue")));

  expect(diffRows.length).toBe(2);
  for (const row of diffRows) {
    expect(row.every((s) => s.bg)).toBe(true);
    expect(lineLen(row)).toBe(72);
  }
});

test("markdown tables render as aligned columns, not a '·'-joined blob", () => {
  const md = "| File | Tests |\n| --- | --- |\n| `a.ts` | 103 |\n| `b.ts` | 14 |";
  const lines = itemsToLines([{ kind: "assistant", id: 1, text: md, done: true }], 80);
  const text = lines.map((l) => l.map((s) => s.text).join("")).join("\n");
  expect(text).toContain("File");
  expect(text).toContain("Tests");
  expect(text).toContain("103");
  expect(text).toMatch(/─{3,}/); // a header underline rule
  expect(text).not.toContain("·  "); // the old flattened cell separator is gone
  // header label and its column value line up (same start column)
  const fileCol = lines.find((l) => l.map((s) => s.text).join("").includes("File"))!;
  const aCol = lines.find((l) => l.map((s) => s.text).join("").includes("a.ts"))!;
  const startOf = (l: typeof fileCol, needle: string) => l.map((s) => s.text).join("").indexOf(needle);
  expect(startOf(aCol, "a.ts")).toBe(startOf(fileCol, "File"));
});

test("consecutive tool calls render tight (no blank line between them)", () => {
  const tools: Item[] = [
    { kind: "tool", id: 1, callId: "a", name: "read_file", arg: "x.ts", status: "ok", summary: "10 lines" },
    { kind: "tool", id: 2, callId: "b", name: "read_file", arg: "y.ts", status: "ok", summary: "20 lines" },
  ];
  const lines = itemsToLines(tools, 80);
  const blanks = lines.filter((l) => l.length === 0).length;
  // exactly ONE leading blank for the whole block — not one per tool.
  expect(blanks).toBe(1);
});
