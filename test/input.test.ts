import { test, expect } from "bun:test";
import type { Key } from "ink";
import { applyKey, sanitizeInputText } from "../src/ui/input.ts";

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

test("shift arrows select text; typing or delete replaces the selection", () => {
  const selected = applyKey({ value: "abcd", cursor: 1 }, "", K({ rightArrow: true, shift: true }));
  expect(selected).toEqual({ type: "edit", state: { value: "abcd", cursor: 2, selectionAnchor: 1 } });
  expect(applyKey({ value: "abcd", cursor: 2, selectionAnchor: 1 }, "X", K())).toEqual({ type: "edit", state: { value: "aXcd", cursor: 2 } });
  expect(applyKey({ value: "abcd", cursor: 3, selectionAnchor: 1 }, "", K({ backspace: true }))).toEqual({ type: "edit", state: { value: "ad", cursor: 1 } });
  expect(applyKey({ value: "abcd", cursor: 0, selectionAnchor: 2 }, "", K({ delete: true }))).toEqual({ type: "edit", state: { value: "cd", cursor: 0 } });
});

test("ctrl-a/cmd-a selects all so delete clears the composer", () => {
  expect(applyKey({ value: "abcd", cursor: 2 }, "a", K({ ctrl: true }))).toEqual({ type: "edit", state: { value: "abcd", cursor: 4, selectionAnchor: 0 } });
  expect(applyKey({ value: "abcd", cursor: 2 }, "a", K({ meta: true }))).toEqual({ type: "edit", state: { value: "abcd", cursor: 4, selectionAnchor: 0 } });
  expect(applyKey({ value: "abcd", cursor: 4, selectionAnchor: 0 }, "", K({ backspace: true }))).toEqual({ type: "edit", state: { value: "", cursor: 0 } });
});

test("control keys: submit, interrupt, history, home/end", () => {
  expect(applyKey({ value: "x", cursor: 1 }, "", K({ return: true })).type).toBe("submit");
  expect(applyKey({ value: "", cursor: 0 }, "", K({ escape: true })).type).toBe("interrupt");
  expect(applyKey({ value: "", cursor: 0 }, "", K({ upArrow: true }))).toEqual({ type: "history", dir: "up" });
  expect(applyKey({ value: "", cursor: 0 }, "", K({ downArrow: true }))).toEqual({ type: "history", dir: "down" });
  expect(applyKey({ value: "abc", cursor: 1 }, "e", K({ ctrl: true }))).toEqual({ type: "edit", state: { value: "abc", cursor: 3 } });
});

test("slash commands still submit on Enter", () => {
  expect(applyKey({ value: "/account", cursor: 8 }, "", { return: true } as any)).toEqual({ type: "submit" });
  expect(applyKey({ value: "/model", cursor: 6 }, "", { return: true } as any)).toEqual({ type: "submit" });
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

test("paste sanitizer strips bracketed paste, ANSI, control, and private-use bytes", () => {
  expect(sanitizeInputText("\x1b[200~hello\r\nworld\x1b[201~")).toBe("hello\nworld");
  expect(sanitizeInputText("[200~hello[201~")).toBe("hello");
  expect(sanitizeInputText("\x1b[31mred\x1b[0m\uE000\u{10EEEE}\x07")).toBe("red");
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

test("vim: insert-mode esc switches to normal; normal-mode i/a/A/I switch back", () => {
  expect(applyKey({ value: "ab", cursor: 1 }, "", K({ escape: true }), { normal: false })).toEqual({ type: "vim", to: "normal" });
  expect(applyKey({ value: "ab", cursor: 1 }, "i", K(), { normal: true })).toEqual({ type: "vim", to: "insert" });
  expect(applyKey({ value: "ab", cursor: 0 }, "a", K(), { normal: true })).toEqual({ type: "vim", to: "insert", state: { value: "ab", cursor: 1 } });
  expect(applyKey({ value: "ab", cursor: 0 }, "A", K(), { normal: true })).toEqual({ type: "vim", to: "insert", state: { value: "ab", cursor: 2 } });
});

test("vim normal: hjwbx movement + edits", () => {
  expect(applyKey({ value: "foo bar", cursor: 7 }, "b", K(), { normal: true })).toEqual({ type: "edit", state: { value: "foo bar", cursor: 4 } });
  expect(applyKey({ value: "foo bar", cursor: 0 }, "w", K(), { normal: true })).toEqual({ type: "edit", state: { value: "foo bar", cursor: 4 } });
  expect(applyKey({ value: "abc", cursor: 1 }, "x", K(), { normal: true })).toEqual({ type: "edit", state: { value: "ac", cursor: 1 } });
  expect(applyKey({ value: "hello world", cursor: 5 }, "D", K(), { normal: true })).toEqual({ type: "edit", state: { value: "hello", cursor: 5 } });
  expect(applyKey({ value: "x", cursor: 0 }, "$", K(), { normal: true })).toEqual({ type: "edit", state: { value: "x", cursor: 1 } });
  // ⏎ still submits from normal mode
  expect(applyKey({ value: "x", cursor: 1 }, "", K({ return: true }), { normal: true }).type).toBe("submit");
})

// ── extendUnitSelection: word/line-wise drag after a double/triple click ──────
import { extendUnitSelection } from "../src/ui/input.ts";

test("word drag forward hulls whole words on both sides", () => {
  const v = "alpha beta gamma";
  // double-clicked "alpha" (0..5), dragged into the middle of "gamma" (off 13)
  const e = extendUnitSelection(v, { start: 0, end: 5 }, 13, "word");
  expect([e.selectionAnchor, e.cursor]).toEqual([0, 16]); // alpha..gamma, whole words
});

test("word drag backward keeps the anchor word's end and extends to the word start", () => {
  const v = "alpha beta gamma";
  // double-clicked "gamma" (11..16), dragged back into "alpha" (off 2)
  const e = extendUnitSelection(v, { start: 11, end: 16 }, 2, "word");
  expect([e.cursor, e.selectionAnchor]).toEqual([0, 16]);
});

test("word drag within the anchor word keeps the original selection (trackpad micro-motion)", () => {
  const v = "alpha beta";
  const e = extendUnitSelection(v, { start: 0, end: 5 }, 3, "word");
  expect([e.selectionAnchor, e.cursor]).toEqual([0, 5]);
});

test("line drag hulls whole lines", () => {
  const v = "one\ntwo\nthree";
  // triple-clicked line "two" (4..7), dragged down into "three" (off 9)
  const down = extendUnitSelection(v, { start: 4, end: 7 }, 9, "line");
  expect([down.selectionAnchor, down.cursor]).toEqual([4, 13]);
  // dragged up into "one" (off 1)
  const up = extendUnitSelection(v, { start: 4, end: 7 }, 1, "line");
  expect([up.cursor, up.selectionAnchor]).toEqual([0, 7]);
});

// ── soft wrap (wrapMap / wrapCaret / wrapOffset) ──────────────────────────────
import { wrapMap, wrapCaret, wrapOffset } from "../src/ui/input.ts";

test("wrapMap chunks long lines and keeps short/empty lines as single rows", () => {
  expect(wrapMap("", 10)).toEqual([{ start: 0, len: 0 }]);
  expect(wrapMap("hello", 10)).toEqual([{ start: 0, len: 5 }]);
  // 25 chars at width 10 → 10 + 10 + 5
  expect(wrapMap("a".repeat(25), 10)).toEqual([
    { start: 0, len: 10 }, { start: 10, len: 10 }, { start: 20, len: 5 },
  ]);
  // multi-line: each logical line wraps independently (newline not counted)
  expect(wrapMap("abcdefghijkl\nxy", 10)).toEqual([
    { start: 0, len: 10 }, { start: 10, len: 2 }, { start: 13, len: 2 },
  ]);
});

test("wrapCaret: interior chunk boundary lands on the next row; line end uses the slack cell", () => {
  const v = "a".repeat(25);
  expect(wrapCaret(v, 10, 0)).toEqual({ row: 0, col: 0 });
  expect(wrapCaret(v, 10, 10)).toEqual({ row: 1, col: 0 }); // boundary → next row
  expect(wrapCaret(v, 10, 25)).toEqual({ row: 2, col: 5 }); // line end
  const full = "a".repeat(20);
  expect(wrapCaret(full, 10, 20)).toEqual({ row: 1, col: 10 }); // exact-fit end → slack
});

test("wrapOffset is the inverse mouse map (clamped to the row)", () => {
  const v = "a".repeat(25) + "\nxy";
  expect(wrapOffset(v, 10, 0, 3)).toBe(3);
  expect(wrapOffset(v, 10, 1, 3)).toBe(13);
  expect(wrapOffset(v, 10, 2, 99)).toBe(25); // clamp to chunk len
  expect(wrapOffset(v, 10, 3, 1)).toBe(27); // second logical line
  expect(wrapOffset(v, 10, 99, 0)).toBe(26); // row clamp
});

// Backslash-Enter = newline (terminal-agnostic shift+enter substitute: most
// terminals send bare CR for shift+enter, so Ink never sees the modifier).
test("backslash before the cursor + enter inserts a newline instead of submitting", () => {
  const s = { value: "first line\\", cursor: 11 };
  const a = applyKey(s, "", { return: true } as any);
  expect(a.type).toBe("edit");
  if (a.type === "edit") {
    expect(a.state.value).toBe("first line\n");
    expect(a.state.cursor).toBe(11);
  }
});

test("plain enter without a trailing backslash still submits", () => {
  expect(applyKey({ value: "no continuation", cursor: 15 }, "", { return: true } as any).type).toBe("submit");
  // backslash elsewhere in the text (not at the cursor) does not block submit
  expect(applyKey({ value: "a\\b", cursor: 1 }, "", { return: true } as any).type).toBe("submit");
});
