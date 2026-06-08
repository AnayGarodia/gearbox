import { test, expect } from "bun:test";
import { hullSelection } from "../src/ui/components/Viewport.tsx";

// hullSelection powers word/line-granular drag: dragging out from a double- or
// triple-click must keep whole words/lines selected on BOTH sides of the anchor.
test("hullSelection covers both ranges on one line, either drag direction", () => {
  const wordA = { startLine: 0, startCol: 0, endLine: 0, endCol: 4 };
  const wordB = { startLine: 0, startCol: 10, endLine: 0, endCol: 14 };
  // drag right: anchor=A, head=B
  expect(hullSelection(wordA, wordB)).toEqual({ startLine: 0, startCol: 0, endLine: 0, endCol: 14 });
  // drag left: anchor=B, head=A → same hull (never collapses to one word)
  expect(hullSelection(wordB, wordA)).toEqual({ startLine: 0, startCol: 0, endLine: 0, endCol: 14 });
});

test("hullSelection spans lines and survives a reversed (drag-up) range", () => {
  const anchor = { startLine: 3, startCol: 0, endLine: 3, endCol: 5 };
  const headUp = { startLine: 1, startCol: 2, endLine: 1, endCol: 6 };
  expect(hullSelection(anchor, headUp)).toEqual({ startLine: 1, startCol: 2, endLine: 3, endCol: 5 });
});

test("hullSelection normalizes an internally-reversed range before hulling", () => {
  // a is stored end-before-start (a raw drag can produce this); hull still correct.
  const reversed = { startLine: 2, startCol: 8, endLine: 2, endCol: 1 };
  const other = { startLine: 2, startCol: 12, endLine: 2, endCol: 16 };
  expect(hullSelection(reversed, other)).toEqual({ startLine: 2, startCol: 1, endLine: 2, endCol: 16 });
});
