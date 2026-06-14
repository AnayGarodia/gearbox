// Terminal multi-select (checkbox). Used by `gearbox onboard` to let you pick
// WHICH detected credentials to import instead of all-or-nothing.
//
// Split into a PURE reducer/renderer (fully tested) and a thin I/O driver that
// runs the raw-mode keypress loop on a real TTY, or reads one line in piped/CI
// mode. The reducer holds all the logic so the interactive path has nothing to
// get wrong beyond byte parsing.

export interface MultiSelectState {
  cursor: number;
  selected: boolean[];
  done: boolean;
  cancelled: boolean;
}

export type MultiSelectKey = "up" | "down" | "toggle" | "all" | "none" | "confirm" | "cancel";

export function initMultiSelect(n: number, allSelected = true): MultiSelectState {
  return { cursor: 0, selected: Array.from({ length: n }, () => allSelected), done: false, cancelled: false };
}

export function multiSelectReduce(s: MultiSelectState, key: MultiSelectKey): MultiSelectState {
  const n = s.selected.length;
  if (n === 0) return { ...s, done: true };
  switch (key) {
    case "up":
      return { ...s, cursor: (s.cursor - 1 + n) % n };
    case "down":
      return { ...s, cursor: (s.cursor + 1) % n };
    case "toggle": {
      const selected = s.selected.slice();
      selected[s.cursor] = !selected[s.cursor];
      return { ...s, selected };
    }
    case "all":
      return { ...s, selected: s.selected.map(() => true) };
    case "none":
      return { ...s, selected: s.selected.map(() => false) };
    case "confirm":
      return { ...s, done: true };
    case "cancel":
      return { ...s, done: true, cancelled: true };
    default:
      return s;
  }
}

export function selectedIndices(s: MultiSelectState): number[] {
  return s.selected.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
}

export interface CheckboxColors {
  R: string; C: string; G: string; D: string; B: string;
}

// Renders the list as lines (no cursor moves) — the driver handles redraw.
export function renderMultiSelectLines(items: string[], s: MultiSelectState, c?: Partial<CheckboxColors>): string[] {
  const R = c?.R ?? "", C = c?.C ?? "", G = c?.G ?? "", D = c?.D ?? "", B = c?.B ?? "";
  const lines = items.map((label, i) => {
    const here = i === s.cursor;
    const box = s.selected[i] ? `${G}[x]${R}` : "[ ]";
    const pointer = here ? `${C}❯${R}` : " ";
    const text = here ? `${B}${label}${R}` : label;
    return `  ${pointer} ${box} ${text}`;
  });
  lines.push(`${D}    ↑↓ move · space toggle · a all · n none · ⏎ import · esc skip${R}`);
  return lines;
}

// Parse a piped/CI answer line into selected indices. "" or "all" → all; "none"
// → none; otherwise comma/space-separated 1-based numbers ("1,3" → [0,2]).
export function parseSelectionLine(line: string, n: number): number[] {
  const t = line.trim().toLowerCase();
  if (t === "" || t === "all" || t === "y" || t === "yes") return Array.from({ length: n }, (_, i) => i);
  if (t === "none" || t === "skip" || t === "n" || t === "no") return [];
  const out = new Set<number>();
  for (const tok of t.split(/[\s,]+/)) {
    const k = Number(tok);
    if (Number.isInteger(k) && k >= 1 && k <= n) out.add(k - 1);
  }
  return [...out].sort((a, b) => a - b);
}

const KEY = {
  UP: "\x1b[A",
  DOWN: "\x1b[B",
  CR: "\r",
  LF: "\n",
  CTRL_C: "\x03",
  ESC: "\x1b",
};

/**
 * Run an interactive checkbox over `items`. On a TTY it's an arrow-key/space
 * picker; in piped/CI mode it reads a single answer line via `readLine`
 * ("all" / "none" / "1,3"). Returns the selected indices, or null if cancelled.
 */
export async function promptMultiSelect(
  items: string[],
  opts: { title?: string; colors?: Partial<CheckboxColors>; readLine?: () => Promise<string>; allSelected?: boolean } = {},
): Promise<number[] | null> {
  if (items.length === 0) return [];
  const stdin = process.stdin;
  const isTTY = Boolean(stdin.isTTY) && typeof stdin.setRawMode === "function";

  if (!isTTY) {
    // Piped/CI: list the items, read one selection line.
    if (opts.title) process.stdout.write(opts.title + "\n");
    items.forEach((l, i) => process.stdout.write(`  ${i + 1}) ${l}\n`));
    process.stdout.write("  import which? (all / none / e.g. 1,3): ");
    const line = opts.readLine ? await opts.readLine() : "all";
    return parseSelectionLine(line, items.length);
  }

  let state = initMultiSelect(items.length, opts.allSelected ?? true);
  const C = opts.colors;
  const draw = (first: boolean) => {
    const lines = renderMultiSelectLines(items, state, C);
    if (!first) process.stdout.write(`\x1b[${lines.length}A`); // cursor up to overwrite
    for (const l of lines) process.stdout.write(`\x1b[2K${l}\n`); // clear line + write
  };
  if (opts.title) process.stdout.write(opts.title + "\n");
  process.stdout.write("\x1b[?25l"); // hide cursor
  draw(true);

  return await new Promise<number[] | null>((resolve) => {
    const onData = (buf: Buffer) => {
      const s = buf.toString("utf8");
      let key: MultiSelectKey | null = null;
      if (s === KEY.UP || s === "k") key = "up";
      else if (s === KEY.DOWN || s === "j") key = "down";
      else if (s === " ") key = "toggle";
      else if (s === "a") key = "all";
      else if (s === "n") key = "none";
      else if (s === KEY.CR || s === KEY.LF) key = "confirm";
      else if (s === KEY.ESC || s === KEY.CTRL_C || s === "q") key = "cancel";
      if (!key) return;
      state = multiSelectReduce(state, key);
      if (state.done) {
        cleanup();
        resolve(state.cancelled ? null : selectedIndices(state));
        return;
      }
      draw(false);
    };
    const cleanup = () => {
      stdin.removeListener("data", onData);
      try { stdin.setRawMode(false); } catch {}
      stdin.pause();
      process.stdout.write("\x1b[?25h"); // restore cursor
    };
    try { stdin.setRawMode(true); } catch {}
    stdin.resume();
    stdin.on("data", onData);
  });
}
