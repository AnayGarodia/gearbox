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

test("kill bindings: ⌃U to line start, ⌃K to line end, ⌃W word back", () => {
  // ⌃U deletes from line start to cursor
  expect(applyKey({ value: "hello world", cursor: 6 }, "u", K({ ctrl: true }))).toEqual({ type: "edit", state: { value: "world", cursor: 0 } });
  // ⌃K deletes from cursor to line end
  expect(applyKey({ value: "hello world", cursor: 5 }, "k", K({ ctrl: true }))).toEqual({ type: "edit", state: { value: "hello", cursor: 5 } });
  // ⌃W deletes the previous word
  expect(applyKey({ value: "foo bar baz", cursor: 11 }, "w", K({ ctrl: true }))).toEqual({ type: "edit", state: { value: "foo bar ", cursor: 8 } });
  // ⌥⌫ also deletes the previous word
  expect(applyKey({ value: "foo bar", cursor: 7 }, "", K({ meta: true, backspace: true }))).toEqual({ type: "edit", state: { value: "foo ", cursor: 4 } });
});

test("word jumps: ⌥/⌃ + arrows move by word", () => {
  expect(applyKey({ value: "foo bar baz", cursor: 11 }, "", K({ meta: true, leftArrow: true }))).toEqual({ type: "edit", state: { value: "foo bar baz", cursor: 8 } });
  expect(applyKey({ value: "foo bar baz", cursor: 0 }, "", K({ ctrl: true, rightArrow: true }))).toEqual({ type: "edit", state: { value: "foo bar baz", cursor: 3 } });
});

test("⌃D forward-deletes; no-op at end of input", () => {
  expect(applyKey({ value: "abc", cursor: 1 }, "d", K({ ctrl: true }))).toEqual({ type: "edit", state: { value: "ac", cursor: 1 } });
  expect(applyKey({ value: "abc", cursor: 3 }, "d", K({ ctrl: true }))).toEqual({ type: "none" });
});

test("kill bindings respect line boundaries in multi-line input", () => {
  const v = "alpha\nbeta gamma";
  // ⌃U on line 1 (cursor after 'beta ') deletes only to that line's start
  expect(applyKey({ value: v, cursor: 11 }, "u", K({ ctrl: true }))).toEqual({ type: "edit", state: { value: "alpha\ngamma", cursor: 6 } });
})
