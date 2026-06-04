// Pure key → action reducer for the composer. Kept pure so it's unit-tested
// without a terminal. The Composer's useInput just dispatches what this returns.
// Supports multi-line values: ⌃J / shift+⏎ / alt+⏎ insert a newline, ⏎ submits,
// ↑/↓ move between lines (falling through to history at the top/bottom line),
// and pasted multi-line text is inserted literally (CR normalized, paste markers
// stripped) instead of submitting on every embedded newline.
import type { Key } from "ink";

export interface Edit {
  value: string;
  cursor: number;
  selectionAnchor?: number;
}

export type KeyAction =
  | { type: "edit"; state: Edit }
  | { type: "submit" }
  | { type: "history"; dir: "up" | "down" }
  | { type: "interrupt" }
  | { type: "vim"; to: "insert" | "normal"; state?: Edit } // switch vim sub-mode (+ optional cursor move)
  | { type: "none" };

const NL = "\n";

export function selectionRange(s: Edit): [number, number] | null {
  if (s.selectionAnchor == null || s.selectionAnchor === s.cursor) return null;
  return [Math.min(s.selectionAnchor, s.cursor), Math.max(s.selectionAnchor, s.cursor)];
}

export function sanitizeInputText(input: string): string {
  return input
    .replace(/\x1b\[20[01]~/g, "")
    .replace(/\[20[01]~/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b./g, "")
    .replace(/[\uE000-\uF8FF]/g, "")
    .replace(/[\u{10EEEE}-\u{10FFFF}]/gu, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/\r\n?/g, NL);
}

/** Cursor's line index, column, and the offset where its line starts. */
export function caretPos(value: string, cursor: number): { lineIdx: number; col: number; lineStart: number } {
  const before = value.slice(0, cursor);
  const lineStart = before.lastIndexOf(NL) + 1;
  return { lineIdx: before.split(NL).length - 1, col: cursor - lineStart, lineStart };
}

export function offsetAt(value: string, lineIdx: number, col: number): number {
  const lines = value.split(NL);
  const li = Math.max(0, Math.min(lineIdx, lines.length - 1));
  let off = 0;
  for (let i = 0; i < li; i++) off += lines[i]!.length + 1;
  return off + Math.min(col, lines[li]!.length);
}

const insert = (s: Edit, text: string): KeyAction => {
  const sel = selectionRange(s);
  const start = sel?.[0] ?? s.cursor;
  const end = sel?.[1] ?? s.cursor;
  return {
    type: "edit",
    state: { value: s.value.slice(0, start) + text + s.value.slice(end), cursor: start + text.length },
  };
};

const at = (value: string, cursor: number, selectionAnchor?: number): KeyAction => ({ type: "edit", state: { value, cursor, selectionAnchor } });

const move = (s: Edit, cursor: number, select?: boolean): KeyAction => at(s.value, cursor, select ? s.selectionAnchor ?? s.cursor : undefined);

function deleteSelection(s: Edit): KeyAction | null {
  const sel = selectionRange(s);
  if (!sel) return null;
  return { type: "edit", state: { value: s.value.slice(0, sel[0]) + s.value.slice(sel[1]), cursor: sel[0] } };
}

// Word boundaries (readline-style): a word is a run of non-whitespace.
function wordLeft(v: string, c: number): number {
  let i = c;
  while (i > 0 && /\s/.test(v[i - 1]!)) i--;
  while (i > 0 && !/\s/.test(v[i - 1]!)) i--;
  return i;
}
function wordRight(v: string, c: number): number {
  let i = c;
  while (i < v.length && /\s/.test(v[i]!)) i++;
  while (i < v.length && !/\s/.test(v[i]!)) i++;
  return i;
}
function lineEndOf(value: string, cursor: number): number {
  const nl = value.indexOf(NL, cursor);
  return nl === -1 ? value.length : nl;
}

// Vim NORMAL-mode reducer: movement + a handful of edit/insert commands. Returns
// a normal `edit`/`submit`/`history` action, or a `vim` action to switch to
// insert (optionally moving the cursor first). Pure + tested.
export function vimNormal(s: Edit, input: string, key: Key): KeyAction {
  const { lineStart } = caretPos(s.value, s.cursor);
  const end = lineEndOf(s.value, s.cursor);
  if (key.return) return { type: "submit" };
  if (key.upArrow || input === "k") return up(s);
  if (key.downArrow || input === "j") return down(s);
  switch (input) {
    case "i": return { type: "vim", to: "insert" };
    case "a": return { type: "vim", to: "insert", state: { value: s.value, cursor: Math.min(s.value.length, s.cursor + 1) } };
    case "A": return { type: "vim", to: "insert", state: { value: s.value, cursor: end } };
    case "I": return { type: "vim", to: "insert", state: { value: s.value, cursor: lineStart } };
    case "o": return { type: "vim", to: "insert", state: { value: s.value.slice(0, end) + NL + s.value.slice(end), cursor: end + 1 } };
    case "h": return at(s.value, Math.max(0, s.cursor - 1));
    case "l": return at(s.value, Math.min(s.value.length, s.cursor + 1));
    case "0": return at(s.value, lineStart);
    case "$": return at(s.value, end);
    case "w": {
      let p = wordRight(s.value, s.cursor);
      while (p < s.value.length && /\s/.test(s.value[p]!)) p++; // vim w → next word start
      return at(s.value, p);
    }
    case "b": return at(s.value, wordLeft(s.value, s.cursor));
    case "x": return { type: "edit", state: { value: s.value.slice(0, s.cursor) + s.value.slice(s.cursor + 1), cursor: Math.min(s.cursor, Math.max(0, s.value.length - 1)) } };
    case "D": return { type: "edit", state: { value: s.value.slice(0, s.cursor) + s.value.slice(end), cursor: s.cursor } };
    case "C": return { type: "vim", to: "insert", state: { value: s.value.slice(0, s.cursor) + s.value.slice(end), cursor: s.cursor } };
    default: return { type: "none" };
  }
}

function up(s: Edit): KeyAction {
  const { lineIdx, col } = caretPos(s.value, s.cursor);
  if (lineIdx > 0) return at(s.value, offsetAt(s.value, lineIdx - 1, col));
  return { type: "history", dir: "up" };
}
function down(s: Edit): KeyAction {
  const lines = s.value.split(NL);
  const { lineIdx, col } = caretPos(s.value, s.cursor);
  if (lineIdx < lines.length - 1) return at(s.value, offsetAt(s.value, lineIdx + 1, col));
  return { type: "history", dir: "down" };
}

export function applyKey(s: Edit, input: string, key: Key, vim?: { normal: boolean }): KeyAction {
  if (vim) {
    if (vim.normal) return vimNormal(s, input, key);
    if (key.escape) return { type: "vim", to: "normal" }; // insert → normal
  }
  // Newline: modifier+Enter or ⌃J. Checked before plain Enter (submit).
  if ((key.return && (key.shift || key.meta)) || (key.ctrl && input === "j")) return insert(s, NL);
  if (key.return) return { type: "submit" };
  if (key.escape) return { type: "interrupt" };

  const lines = s.value.split(NL);
  const { lineIdx, col, lineStart } = caretPos(s.value, s.cursor);

  if (key.upArrow) {
    if (lineIdx > 0) return { type: "edit", state: { value: s.value, cursor: offsetAt(s.value, lineIdx - 1, col) } };
    return { type: "history", dir: "up" };
  }
  if (key.downArrow) {
    if (lineIdx < lines.length - 1) return { type: "edit", state: { value: s.value, cursor: offsetAt(s.value, lineIdx + 1, col) } };
    return { type: "history", dir: "down" };
  }
  // Word jumps: Option/Alt+← → (key.meta) or Ctrl+← →. Must precede plain arrows.
  if ((key.meta || key.ctrl) && key.leftArrow) return move(s, wordLeft(s.value, s.cursor), key.shift);
  if ((key.meta || key.ctrl) && key.rightArrow) return move(s, wordRight(s.value, s.cursor), key.shift);
  if (key.leftArrow) return move(s, Math.max(0, s.cursor - 1), key.shift);
  if (key.rightArrow) return move(s, Math.min(s.value.length, s.cursor + 1), key.shift);
  if ((key.meta || key.ctrl) && input === "a") return at(s.value, s.value.length, 0); // select all
  if (key.ctrl && input === "e") return move(s, lineEndOf(s.value, s.cursor), key.shift); // line end
  // Kill bindings (readline): ⌃U to line start, ⌃K to line end, ⌃W / ⌥⌫ word back.
  if (key.ctrl && input === "u") return { type: "edit", state: { value: s.value.slice(0, lineStart) + s.value.slice(s.cursor), cursor: lineStart } };
  if (key.ctrl && input === "k") return { type: "edit", state: { value: s.value.slice(0, s.cursor) + s.value.slice(lineEndOf(s.value, s.cursor)), cursor: s.cursor } };
  if ((key.ctrl && input === "w") || (key.meta && (key.backspace || key.delete))) {
    const wl = wordLeft(s.value, s.cursor);
    if (wl === s.cursor) return { type: "none" };
    return { type: "edit", state: { value: s.value.slice(0, wl) + s.value.slice(s.cursor), cursor: wl } };
  }
  if (key.ctrl && input === "d") {
    const del = deleteSelection(s);
    if (del) return del;
    if (s.cursor >= s.value.length) return { type: "none" }; // EOF handled by caller
    return { type: "edit", state: { value: s.value.slice(0, s.cursor) + s.value.slice(s.cursor + 1), cursor: s.cursor } };
  }
  if (key.backspace || key.delete) {
    const del = deleteSelection(s);
    if (del) return del;
    if (s.cursor <= 0) return { type: "none" };
    return { type: "edit", state: { value: s.value.slice(0, s.cursor - 1) + s.value.slice(s.cursor), cursor: s.cursor - 1 } };
  }
  if (input && !key.ctrl && !key.meta && !key.tab) {
    // Text or a pasted chunk: drop bracketed-paste markers, normalize CR/CRLF → \n.
    const clean = sanitizeInputText(input);
    return clean ? insert(s, clean) : { type: "none" };
  }
  return { type: "none" };
}
