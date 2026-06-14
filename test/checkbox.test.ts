import { test, expect } from "bun:test";
import { initMultiSelect, multiSelectReduce, selectedIndices, parseSelectionLine, renderMultiSelectLines } from "../src/ui/checkbox.ts";

test("starts all-selected by default; toggle off then confirm", () => {
  let s = initMultiSelect(3);
  expect(selectedIndices(s)).toEqual([0, 1, 2]);
  s = multiSelectReduce(s, "down"); // cursor → 1
  s = multiSelectReduce(s, "toggle"); // uncheck 1
  s = multiSelectReduce(s, "confirm");
  expect(s.done).toBe(true);
  expect(s.cancelled).toBe(false);
  expect(selectedIndices(s)).toEqual([0, 2]);
});

test("cursor wraps both directions", () => {
  let s = initMultiSelect(3);
  s = multiSelectReduce(s, "up"); // 0 → 2 (wrap)
  expect(s.cursor).toBe(2);
  s = multiSelectReduce(s, "down"); // 2 → 0 (wrap)
  expect(s.cursor).toBe(0);
});

test("all / none toggles every item", () => {
  let s = initMultiSelect(3, false);
  expect(selectedIndices(s)).toEqual([]);
  s = multiSelectReduce(s, "all");
  expect(selectedIndices(s)).toEqual([0, 1, 2]);
  s = multiSelectReduce(s, "none");
  expect(selectedIndices(s)).toEqual([]);
});

test("cancel sets cancelled", () => {
  let s = multiSelectReduce(initMultiSelect(2), "cancel");
  expect(s.done).toBe(true);
  expect(s.cancelled).toBe(true);
});

test("empty list is immediately done", () => {
  const s = multiSelectReduce(initMultiSelect(0), "toggle");
  expect(s.done).toBe(true);
});

test("parseSelectionLine: all / none / numbers", () => {
  expect(parseSelectionLine("", 3)).toEqual([0, 1, 2]);
  expect(parseSelectionLine("all", 3)).toEqual([0, 1, 2]);
  expect(parseSelectionLine("none", 3)).toEqual([]);
  expect(parseSelectionLine("1,3", 3)).toEqual([0, 2]);
  expect(parseSelectionLine("2 3", 3)).toEqual([1, 2]);
  expect(parseSelectionLine("9", 3)).toEqual([]); // out of range dropped
});

test("render marks cursor and checkboxes", () => {
  const s = initMultiSelect(2);
  const lines = renderMultiSelectLines(["A", "B"], s);
  expect(lines[0]).toContain("[x] A");
  expect(lines[1]).toContain("[x] B");
  expect(lines.at(-1)).toContain("space toggle");
});
