// Dismissible command panel — the model + pure helpers behind the Esc-closable
// overlay that big "info dump" commands (/help, /account, /context, /cost, /keys,
// /model, /memory) open instead of dumping into the transcript. Fullscreen only
// (inline mode keeps printing inline — it has native scrollback). Kept pure and
// tested; the React/Ink rendering lives in components/Panel.tsx and the wiring in
// App.tsx.
import type { Item } from "./types.ts";

export interface PanelModelRow {
  id: string;
  label: string;
  provider: string;
  current: boolean;
}

export interface PanelSessionRow {
  id: string;
  when: string; // relative time, e.g. "19h ago"
  turns: number;
  title: string;
}

export type PanelState =
  // view-only: a prebuilt transcript Item rendered + scrolled in the panel
  | { kind: "static"; title: string; items: Item[]; scroll: number }
  // interactive list: switch the selected account
  | { kind: "accounts"; title: string; index: number }
  // interactive list: pin the selected model, with type-to-filter
  | { kind: "models"; title: string; index: number; filter: string }
  // interactive list: load the selected saved session
  | { kind: "sessions"; title: string; index: number };

export const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(n, hi));

/** Clamp a selection index into [0, count-1] (0 when empty). */
export const clampIndex = (i: number, count: number): number => (count <= 0 ? 0 : clamp(i, 0, count - 1));

/** Clamp a scroll offset into [0, max]. */
export const clampScroll = (s: number, max: number): number => clamp(s, 0, Math.max(0, max));

/** The body area of a panel of total `height` (minus the header + footer rows). */
export const panelBodyHeight = (height: number): number => Math.max(1, height - 2);

/**
 * First row to show so `index` stays visible within a `viewH`-row window — keeps
 * the selection on screen as you arrow through a list longer than the window.
 */
export function windowStart(index: number, count: number, viewH: number): number {
  if (count <= viewH) return 0;
  const half = Math.floor(viewH / 2);
  return clamp(index - half, 0, count - viewH);
}

/** Filter model rows by a typed query (substring on label/id/provider, case-insensitive). */
export function filterModelRows(rows: PanelModelRow[], filter: string): PanelModelRow[] {
  const q = filter.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => r.label.toLowerCase().includes(q) || r.id.toLowerCase().includes(q) || r.provider.toLowerCase().includes(q));
}

/** Append a printable char to a panel's model filter (and reset selection to top). */
export function appendFilter(panel: Extract<PanelState, { kind: "models" }>, ch: string): PanelState {
  return { ...panel, filter: panel.filter + ch, index: 0 };
}

/** Backspace the model filter (reset selection to top). */
export function backspaceFilter(panel: Extract<PanelState, { kind: "models" }>): PanelState {
  return { ...panel, filter: panel.filter.slice(0, -1), index: 0 };
}
