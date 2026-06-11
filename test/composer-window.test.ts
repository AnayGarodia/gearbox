// The composer's fixed-height scroll window: long input must never grow the
// box past MAX_INPUT_ROWS (it used to shove the whole frame off the screen) —
// it scrolls internally, cursor always in view.
import { test, expect } from "bun:test";
import { composerWindow, composerVisibleRows, composerRows, MAX_INPUT_ROWS, composerWrapW } from "../src/ui/components/Composer.tsx";

const W = 80;
const long = Array.from({ length: 40 }, (_, i) => `line number ${i}`).join("\n");

test("visible rows are capped at MAX_INPUT_ROWS", () => {
  expect(composerRows(long, W)).toBeGreaterThan(MAX_INPUT_ROWS); // it IS long
  expect(composerVisibleRows(long, W)).toBe(MAX_INPUT_ROWS); // but the box isn't
  expect(composerVisibleRows("short", W)).toBe(1);
});

test("the window follows the cursor and stays in bounds", () => {
  // cursor at start → window at top
  expect(composerWindow(long, W, 0).start).toBe(0);
  // cursor at end → window pinned to the bottom
  const end = composerWindow(long, W, long.length);
  expect(end.start + end.count).toBe(end.total);
  expect(end.count).toBe(MAX_INPUT_ROWS);
  // any cursor position keeps its row inside the window
  for (const off of [0, 100, 250, long.length - 1]) {
    const w = composerWindow(long, W, off);
    expect(w.start).toBeGreaterThanOrEqual(0);
    expect(w.start + w.count).toBeLessThanOrEqual(w.total);
  }
});

test("short input is untouched (no window math)", () => {
  const w = composerWindow("hello\nworld", W, 3);
  expect(w).toEqual({ start: 0, count: 2, total: 2 });
});
