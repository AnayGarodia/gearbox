import { test, expect } from "bun:test";
import { initAskPicker, askPickerReduce, renderAskQuestion } from "../src/ui/ask-picker.ts";
import type { AskQuestion } from "../src/ask.ts";

const Q: AskQuestion[] = [
  { question: "Language?", options: [{ label: "TypeScript" }, { label: "Python" }] },
  { question: "Features?", multiSelect: true, options: [{ label: "auth" }, { label: "billing" }, { label: "search" }] },
];

test("single-select: enter picks the cursor and advances", () => {
  let s = initAskPicker();
  s = askPickerReduce(s, "down", Q); // cursor → Python
  s = askPickerReduce(s, "confirm", Q); // pick Python, advance to Q2
  expect(s.qIndex).toBe(1);
  expect(s.answers[0]).toEqual({ question: "Language?", answers: ["Python"] });
});

test("multi-select: space toggles, enter confirms the set and finishes", () => {
  let s = initAskPicker();
  s = askPickerReduce(s, "confirm", Q); // pick TypeScript (cursor 0), advance
  s = askPickerReduce(s, "toggle", Q); // toggle auth
  s = askPickerReduce(s, "down", Q);
  s = askPickerReduce(s, "down", Q);
  s = askPickerReduce(s, "toggle", Q); // toggle search
  s = askPickerReduce(s, "confirm", Q);
  expect(s.done).toBe(true);
  expect(s.cancelled).toBe(false);
  expect(s.answers[1]).toEqual({ question: "Features?", answers: ["auth", "search"] });
});

test("multi-select with nothing toggled defaults to the cursor option", () => {
  let s = initAskPicker();
  s = askPickerReduce(s, "confirm", Q); // Q1 → TypeScript
  s = askPickerReduce(s, "confirm", Q); // Q2, nothing toggled → cursor (auth)
  expect(s.answers[1]).toEqual({ question: "Features?", answers: ["auth"] });
});

test("cursor wraps; cancel sets cancelled", () => {
  let s = initAskPicker();
  s = askPickerReduce(s, "up", Q); // 0 → 1 (wrap, 2 options)
  expect(s.cursor).toBe(1);
  s = askPickerReduce(s, "cancel", Q);
  expect(s.cancelled).toBe(true);
  expect(s.done).toBe(true);
});

test("render shows the current question, counter, and a radio/checkbox", () => {
  const s = initAskPicker();
  const lines = renderAskQuestion(Q, s);
  expect(lines[0]).toContain("(1/2)");
  expect(lines[0]).toContain("Language?");
  expect(lines.some((l) => l.includes("TypeScript"))).toBe(true);
  expect(lines.at(-1)).toContain("select");
});
