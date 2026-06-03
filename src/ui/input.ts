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
  if (key.leftArrow) return { type: "edit", state: { value: s.value, cursor: Math.max(0, s.cursor - 1) } };
  if (key.rightArrow) return { type: "edit", state: { value: s.value, cursor: Math.min(s.value.length, s.cursor + 1) } };
  if (key.ctrl && input === "a") return { type: "edit", state: { value: s.value, cursor: lineStart } }; // line home
  if (key.ctrl && input === "e") {
    const nl = s.value.indexOf(NL, s.cursor);
    return { type: "edit", state: { value: s.value, cursor: nl === -1 ? s.value.length : nl } }; // line end
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
