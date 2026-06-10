import { test, expect } from "bun:test";
import { charWidth, displayWidth, sliceWidth } from "../src/ui/width.ts";

// ── charWidth ──

test("charWidth: ASCII is 1", () => {
  expect(charWidth("a".codePointAt(0)!)).toBe(1);
  expect(charWidth(" ".codePointAt(0)!)).toBe(1);
  expect(charWidth("~".codePointAt(0)!)).toBe(1);
});

test("charWidth: CJK and Hangul are 2", () => {
  expect(charWidth("漢".codePointAt(0)!)).toBe(2);
  expect(charWidth("あ".codePointAt(0)!)).toBe(2);
  expect(charWidth("한".codePointAt(0)!)).toBe(2);
  expect(charWidth("，".codePointAt(0)!)).toBe(2); // fullwidth comma
});

test("charWidth: emoji are 2", () => {
  expect(charWidth("🎉".codePointAt(0)!)).toBe(2);
  expect(charWidth("🚀".codePointAt(0)!)).toBe(2);
  expect(charWidth("🩷".codePointAt(0)!)).toBe(2); // U+1FA77, extended-A plane
});

test("charWidth: combining marks and zero-width are 0", () => {
  expect(charWidth(0x0301)).toBe(0); // combining acute
  expect(charWidth(0x200d)).toBe(0); // ZWJ
  expect(charWidth(0xfe0f)).toBe(0); // variation selector-16
  expect(charWidth(0xfeff)).toBe(0); // BOM
});

// ── displayWidth ──

test("displayWidth: pure ASCII equals .length", () => {
  expect(displayWidth("hello world")).toBe(11);
  expect(displayWidth("")).toBe(0);
});

test("displayWidth: CJK counts 2 columns per char", () => {
  expect(displayWidth("漢字")).toBe(4);
  expect(displayWidth("a漢b")).toBe(4);
});

test("displayWidth: emoji counts 2 (surrogate pair = one glyph, not two)", () => {
  expect("🎉".length).toBe(2); // the bug: code units, not columns
  expect(displayWidth("🎉")).toBe(2);
  expect(displayWidth("ok 🎉")).toBe(5);
});

test("displayWidth: combining accents add no width", () => {
  expect(displayWidth("é")).toBe(1); // é decomposed
  expect(displayWidth("café")).toBe(4);
});

// ── sliceWidth ──

test("sliceWidth: ASCII matches .slice", () => {
  expect(sliceWidth("hello", 3)).toEqual({ text: "hel", width: 3 });
  expect(sliceWidth("hi", 10)).toEqual({ text: "hi", width: 2 });
  expect(sliceWidth("hi", 0)).toEqual({ text: "", width: 0 });
});

test("sliceWidth: counts columns, not code units, for wide chars", () => {
  expect(sliceWidth("漢字テスト", 4)).toEqual({ text: "漢字", width: 4 });
  // a wide char that half-fits is left out (width 3 < max 4 is fine)
  expect(sliceWidth("a漢字", 4)).toEqual({ text: "a漢", width: 3 });
});

test("sliceWidth: never splits a surrogate pair", () => {
  const { text } = sliceWidth("🎉🎉", 3); // second emoji half-fits
  expect(text).toBe("🎉");
  for (const ch of text) expect(ch.codePointAt(0)!).toBeGreaterThan(0xffff); // whole pairs only
  // no lone surrogate anywhere
  expect(/[\uD800-\uDFFF]/.test(text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""))).toBe(false);
});

test("sliceWidth: keeps a trailing combining mark with its base inside the budget", () => {
  expect(sliceWidth("éx", 1)).toEqual({ text: "é", width: 1 });
});
