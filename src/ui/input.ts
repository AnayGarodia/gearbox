// Pure key-to-action reducer for the composer. Kept pure so it's unit-tested
// without a terminal; the Composer's useInput just dispatches what this returns.
// Supports multi-line values: ⌃J / shift+⏎ / alt+⏎ insert a newline, ⏎ submits,
// up/down moves between lines (falling through to history at the edges), and
// pasted multi-line text is inserted literally (CR normalized, paste markers
// stripped) rather than submitting on every embedded newline.
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

// ── soft wrap ─────────────────────────────────────────────────────────────────
// The composer SOFT-WRAPS long logical lines at `w` columns. These pure helpers
// are the single source of truth for the display-row geometry: the Composer
// renders from wrapMap, and App's footer estimate + mouse hit-test count the
// same rows — so a wrapped line can never break the row contract again.

/** One entry per DISPLAY row: the slice value.substr(start, len). An empty
 *  logical line still yields a row (len 0). Rows are contiguous: a chunk
 *  boundary shares its offset with the next chunk's start. */
export function wrapMap(value: string, w: number): { start: number; len: number }[] {
  const width = Math.max(1, w);
  const rows: { start: number; len: number }[] = [];
  let off = 0;
  for (const line of value.split(NL)) {
    const chunks = Math.max(1, Math.ceil(line.length / width));
    for (let i = 0; i < chunks; i++) rows.push({ start: off + i * width, len: Math.min(width, line.length - i * width) });
    off += line.length + 1;
  }
  return rows;
}

/** The display row + column the cursor occupies under wrapping. At an interior
 *  chunk boundary the caret lands on the NEXT row's col 0 (where the next typed
 *  character goes); at the very end of a line it sits at col == len — the
 *  renderer reserves one slack cell for exactly that. */
export function wrapCaret(value: string, w: number, cursor: number): { row: number; col: number } {
  const map = wrapMap(value, w);
  for (let i = map.length - 1; i >= 0; i--) {
    const r = map[i]!;
    if (cursor >= r.start && cursor <= r.start + r.len) return { row: i, col: cursor - r.start };
  }
  return { row: 0, col: 0 };
}

/** Offset of a (display row, column) point under wrapping — the mouse map. */
export function wrapOffset(value: string, w: number, row: number, col: number): number {
  const map = wrapMap(value, w);
  const r = map[Math.max(0, Math.min(row, map.length - 1))]!;
  return r.start + Math.max(0, Math.min(col, r.len));
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

// Readline-style word boundaries: a word is a run of non-whitespace characters.
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

// Vim NORMAL-mode reducer: movement plus a handful of edit/insert commands.
// Returns a normal edit/submit/history action, or a vim action to switch to
// insert mode (optionally repositioning the cursor first). Pure, tested.
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
    if (key.escape) return { type: "vim", to: "normal" }; // Esc exits insert mode
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
  // Word jumps via Option/Alt or Ctrl. Must precede plain arrow handling.
  if ((key.meta || key.ctrl) && key.leftArrow) return move(s, wordLeft(s.value, s.cursor), key.shift);
  if ((key.meta || key.ctrl) && key.rightArrow) return move(s, wordRight(s.value, s.cursor), key.shift);
  if (key.leftArrow) return move(s, Math.max(0, s.cursor - 1), key.shift);
  if (key.rightArrow) return move(s, Math.min(s.value.length, s.cursor + 1), key.shift);
  // ⌃A/⌘A select all — a DELIBERATE break from readline's line-start (the
  // composer's fastest clear: select all, delete). ⌃U already covers
  // kill-to-line-start. /keys documents this.
  if ((key.meta || key.ctrl) && input === "a") return at(s.value, s.value.length, 0);
  if (key.ctrl && input === "e") return move(s, lineEndOf(s.value, s.cursor), key.shift); // line end (readline)
  // readline kill bindings: ⌃U to line start, ⌃K to line end, ⌃W / ⌥⌫ word back.
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
    // Drop bracketed-paste markers and normalize CR/CRLF before inserting.
    const clean = sanitizeInputText(input);
    return clean ? insert(s, clean) : { type: "none" };
  }
  return { type: "none" };
}

// ── Mouse selection helpers ────────────────────────────────────────────────

/** Return the character offset corresponding to a column index in a line. */
function offsetInLine(line: string, col: number): number {
  return Math.max(0, Math.min(col, line.length));
}

/** Find the start of the word at `offset` (readline‑style word boundaries). */
function wordStartAt(value: string, offset: number): number {
  let i = offset;
  // skip trailing whitespace
  while (i > 0 && /\s/.test(value[i - 1]!)) i--;
  // skip word characters
  while (i > 0 && !/\s/.test(value[i - 1]!)) i--;
  return i;
}

/** Find the end of the word at `offset` (readline‑style word boundaries). */
function wordEndAt(value: string, offset: number): number {
  let i = offset;
  // skip leading whitespace
  while (i < value.length && /\s/.test(value[i]!)) i++;
  // skip word characters
  while (i < value.length && !/\s/.test(value[i]!)) i++;
  return i;
}

/** Return the start offset of the line that contains `offset`. */
function lineStartAt(value: string, offset: number): number {
  const nl = value.lastIndexOf(NL, offset - 1);
  return nl === -1 ? 0 : nl + 1;
}

/** Return the end offset of the line that contains `offset` (exclusive). */
function lineEndAt(value: string, offset: number): number {
  const nl = value.indexOf(NL, offset);
  return nl === -1 ? value.length : nl;
}

export interface MouseClick {
  /** 0‑based column (character cell) where the click happened. */
  col: number;
  /** 0‑based line index where the click happened. */
  line: number;
  /** Number of consecutive clicks (1 = single, 2 = double, 3 = triple). */
  count: number;
  /** Whether the Shift modifier was held during the click. */
  shift: boolean;
}

/**
 * Apply a mouse click to the current edit state.
 *
 * - Single click: move cursor to the clicked position, clearing any selection.
 * - Double click: select the word under the cursor.
 * - Triple click: select the whole line under the cursor.
 * - Shift‑click: extend the existing selection (or start a new one if there is
 *   no selection) from the current cursor to the clicked position.
 *
 * The returned action is always an `edit` action (or `none` if the click is
 * outside the text).
 */
export function applyMouse(s: Edit, click: MouseClick): KeyAction {
  const lines = s.value.split(NL);
  const lineIdx = Math.max(0, Math.min(click.line, lines.length - 1));
  const line = lines[lineIdx]!;
  const col = offsetInLine(line, click.col);
  const offset = offsetAt(s.value, lineIdx, col);

  // Shift-click: extend the existing selection (or start one) to the clicked position.
  if (click.shift) {
    const anchor = s.selectionAnchor ?? s.cursor;
    return {
      type: "edit",
      state: {
        value: s.value,
        cursor: offset,
        selectionAnchor: anchor,
      },
    };
  }

  // Triple‑click: select the whole line.
  if (click.count >= 3) {
    const lineStart = lineStartAt(s.value, offset);
    const lineEnd = lineEndAt(s.value, offset);
    return {
      type: "edit",
      state: {
        value: s.value,
        cursor: lineEnd,
        selectionAnchor: lineStart,
      },
    };
  }

  // Double‑click: select the word under the cursor.
  if (click.count === 2) {
    const ws = wordStartAt(s.value, offset);
    const we = wordEndAt(s.value, offset);
    return {
      type: "edit",
      state: {
        value: s.value,
        cursor: we,
        selectionAnchor: ws,
      },
    };
  }

  // Single click: move cursor, clear selection.
  return {
    type: "edit",
    state: {
      value: s.value,
      cursor: offset,
      selectionAnchor: undefined,
    },
  };
}

/**
 * Extend a word/line selection during a drag that began with a double or
 * triple click: the selection becomes the hull of the anchor range (the
 * word/line originally clicked) and the word/line under the drag point —
 * whole units stay selected on both sides, like every native text field.
 * The cursor rides the moving end so a later shift-click still extends
 * sensibly. Pure.
 */
export function extendUnitSelection(
  value: string,
  anchor: { start: number; end: number },
  offset: number,
  mode: "word" | "line",
): Edit {
  const start = mode === "line" ? lineStartAt(value, offset) : wordStartAt(value, offset);
  const end = mode === "line" ? lineEndAt(value, offset) : wordEndAt(value, offset);
  // Dragging forward: anchor start stays, cursor extends to the unit's end.
  // Dragging backward: anchor end stays, cursor extends to the unit's start.
  if (end >= anchor.end) return { value, cursor: Math.max(end, anchor.end), selectionAnchor: Math.min(start, anchor.start) };
  return { value, cursor: Math.min(start, anchor.start), selectionAnchor: Math.max(end, anchor.end) };
}