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
