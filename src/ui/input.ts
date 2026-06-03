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
}

export type KeyAction =
  | { type: "edit"; state: Edit }
  | { type: "submit" }
  | { type: "history"; dir: "up" | "down" }
  | { type: "interrupt" }
  | { type: "none" };

const NL = "\n";

/** Cursor's line index, column, and the offset where its line starts. */
export function caretPos(value: string, cursor: number): { lineIdx: number; col: number; lineStart: number } {
  const before = value.slice(0, cursor);
  const lineStart = before.lastIndexOf(NL) + 1;
  return { lineIdx: before.split(NL).length - 1, col: cursor - lineStart, lineStart };
}

function offsetAt(value: string, lineIdx: number, col: number): number {
  const lines = value.split(NL);
  const li = Math.max(0, Math.min(lineIdx, lines.length - 1));
  let off = 0;
  for (let i = 0; i < li; i++) off += lines[i]!.length + 1;
  return off + Math.min(col, lines[li]!.length);
}

const insert = (s: Edit, text: string): KeyAction => ({
  type: "edit",
  state: { value: s.value.slice(0, s.cursor) + text + s.value.slice(s.cursor), cursor: s.cursor + text.length },
});

const at = (value: string, cursor: number): KeyAction => ({ type: "edit", state: { value, cursor } });

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

export function applyKey(s: Edit, input: string, key: Key): KeyAction {
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
  if ((key.meta || key.ctrl) && key.leftArrow) return at(s.value, wordLeft(s.value, s.cursor));
  if ((key.meta || key.ctrl) && key.rightArrow) return at(s.value, wordRight(s.value, s.cursor));
  if (key.leftArrow) return at(s.value, Math.max(0, s.cursor - 1));
  if (key.rightArrow) return at(s.value, Math.min(s.value.length, s.cursor + 1));
  if (key.ctrl && input === "a") return at(s.value, lineStart); // line home
  if (key.ctrl && input === "e") return at(s.value, lineEndOf(s.value, s.cursor)); // line end
  // Kill bindings (readline): ⌃U to line start, ⌃K to line end, ⌃W / ⌥⌫ word back.
  if (key.ctrl && input === "u") return { type: "edit", state: { value: s.value.slice(0, lineStart) + s.value.slice(s.cursor), cursor: lineStart } };
  if (key.ctrl && input === "k") return { type: "edit", state: { value: s.value.slice(0, s.cursor) + s.value.slice(lineEndOf(s.value, s.cursor)), cursor: s.cursor } };
  if ((key.ctrl && input === "w") || (key.meta && (key.backspace || key.delete))) {
    const wl = wordLeft(s.value, s.cursor);
    if (wl === s.cursor) return { type: "none" };
    return { type: "edit", state: { value: s.value.slice(0, wl) + s.value.slice(s.cursor), cursor: wl } };
  }
  if (key.ctrl && input === "d") {
    if (s.cursor >= s.value.length) return { type: "none" }; // EOF handled by caller
    return { type: "edit", state: { value: s.value.slice(0, s.cursor) + s.value.slice(s.cursor + 1), cursor: s.cursor } };
  }
  if (key.backspace || key.delete) {
    if (s.cursor <= 0) return { type: "none" };
    return { type: "edit", state: { value: s.value.slice(0, s.cursor - 1) + s.value.slice(s.cursor), cursor: s.cursor - 1 } };
  }
  if (input && !key.ctrl && !key.meta && !key.tab) {
    // Text or a pasted chunk: drop bracketed-paste markers, normalize CR/CRLF → \n.
    const clean = input.replace(/\x1b\[20[01]~/g, "").replace(/\r\n?/g, NL);
    return clean ? insert(s, clean) : { type: "none" };
  }
  return { type: "none" };
}
