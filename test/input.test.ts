import { test, expect } from "bun:test";
import type { Key } from "ink";
import { applyKey } from "../src/ui/input.ts";

const K = (over: Partial<Key> = {}): Key => ({
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
  pageDown: false, pageUp: false, return: false, escape: false, ctrl: false,
  shift: false, tab: false, backspace: false, delete: false, meta: false,
  ...over,
});

test("typing inserts at the cursor", () => {
  expect(applyKey({ value: "ac", cursor: 1 }, "b", K())).toEqual({ type: "edit", state: { value: "abc", cursor: 2 } });
});

test("backspace deletes before the cursor; no-op at start", () => {
  expect(applyKey({ value: "abc", cursor: 2 }, "", K({ backspace: true }))).toEqual({ type: "edit", state: { value: "ac", cursor: 1 } });
  expect(applyKey({ value: "abc", cursor: 0 }, "", K({ backspace: true }))).toEqual({ type: "none" });
});

test("arrows move the cursor within bounds", () => {
  expect(applyKey({ value: "ab", cursor: 0 }, "", K({ leftArrow: true }))).toEqual({ type: "edit", state: { value: "ab", cursor: 0 } });
  expect(applyKey({ value: "ab", cursor: 1 }, "", K({ rightArrow: true }))).toEqual({ type: "edit", state: { value: "ab", cursor: 2 } });
  expect(applyKey({ value: "ab", cursor: 2 }, "", K({ rightArrow: true }))).toEqual({ type: "edit", state: { value: "ab", cursor: 2 } });
});

test("control keys: submit, interrupt, history, home/end", () => {
  expect(applyKey({ value: "x", cursor: 1 }, "", K({ return: true })).type).toBe("submit");
  expect(applyKey({ value: "", cursor: 0 }, "", K({ escape: true })).type).toBe("interrupt");
  expect(applyKey({ value: "", cursor: 0 }, "", K({ upArrow: true }))).toEqual({ type: "history", dir: "up" });
  expect(applyKey({ value: "", cursor: 0 }, "", K({ downArrow: true }))).toEqual({ type: "history", dir: "down" });
  expect(applyKey({ value: "abc", cursor: 1 }, "a", K({ ctrl: true }))).toEqual({ type: "edit", state: { value: "abc", cursor: 0 } });
  expect(applyKey({ value: "abc", cursor: 1 }, "e", K({ ctrl: true }))).toEqual({ type: "edit", state: { value: "abc", cursor: 3 } });
});

test("newline: ⌃J and shift/alt+Enter insert \\n; plain Enter still submits", () => {
  expect(applyKey({ value: "ab", cursor: 2 }, "j", K({ ctrl: true }))).toEqual({ type: "edit", state: { value: "ab\n", cursor: 3 } });
  expect(applyKey({ value: "ab", cursor: 1 }, "", K({ return: true, shift: true }))).toEqual({ type: "edit", state: { value: "a\nb", cursor: 2 } });
  expect(applyKey({ value: "ab", cursor: 1 }, "", K({ return: true }))).toEqual({ type: "submit" });
});

test("up/down move between lines, then fall through to history at the edges", () => {
  const v = "one\ntwo"; // line 0 = "one", line 1 = "two"
  // cursor at col 3 of line 1 → up moves to line 0 (col clamped to 3)
  expect(applyKey({ value: v, cursor: 7 }, "", K({ upArrow: true }))).toEqual({ type: "edit", state: { value: v, cursor: 3 } });
  // on the top line → history up
  expect(applyKey({ value: v, cursor: 1 }, "", K({ upArrow: true }))).toEqual({ type: "history", dir: "up" });
  // on the bottom line → history down
  expect(applyKey({ value: v, cursor: 5 }, "", K({ downArrow: true }))).toEqual({ type: "history", dir: "down" });
});

test("pasted multi-line chunk inserts literally (no submit), normalizing CRLF", () => {
  const r = applyKey({ value: "", cursor: 0 }, "a\r\nb", K());
  expect(r).toEqual({ type: "edit", state: { value: "a\nb", cursor: 3 } });
});
