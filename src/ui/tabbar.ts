// The clickable session-tab bar that lives in the masthead row (fullscreen):
//   gearbox  1 main  2 fix-auth●  3 docs⚠  +
// Pure layout + hit-test, same pattern as statusBarLayout/statusBarHit: the
// Masthead renders FROM these segments and the mouse handler hit-tests against
// them, so the two can never disagree about where a click lands. Clicking a
// tab switches to it; clicking + creates a new session (its own worktree).
import { displayWidth } from "./width.ts";

export interface TabRow {
  title: string;
  active: boolean;
  busy: boolean;
  needsInput: boolean;
  /** finished a turn while hidden and not yet visited — the cell flips green ✓ */
  done?: boolean;
}

export type TabAction = { type: "switch"; n: number } | { type: "new" } | { type: "close" };

export interface TabSegment {
  text: string; // rendered cell text (marker included) — the hit-test width truth
  x0: number; // 0-based start column, inclusive
  x1: number; // 0-based end column, exclusive
  action: TabAction;
  row: TabRow | null; // null for the + cell
  // Styled parts (concatenate to exactly `text`): the Masthead colors the
  // number, title, and status mark independently without re-deriving widths.
  num?: string; // " 1 "
  title?: string; // truncated title
  mark?: string; // "" | "●" | "⚠"
  close?: string; // trailing cell text: " " normally, " × " on the active cell (multi-tab)
  /** 0-based column where the close (`×`) zone starts, when the cell has one */
  closeX0?: number;
}

const TITLE_MAX = 14;
const GAP = 1; // columns between cells

/** Status marker rendered after the title: needs-input beats done beats busy. */
export const tabMark = (r: TabRow): string => (r.needsInput ? "⚠" : r.done ? "✓" : r.busy ? "●" : "");

/**
 * Lay the cells out from column `left` (0-based), never past `maxX`. Cells that
 * don't fit are dropped from the END except the + cell, which always fits last
 * (it's the affordance the bar exists for). The ACTIVE tab is never dropped:
 * when space runs out, trailing inactive tabs go first.
 */
export function tabBarSegments(rows: TabRow[], left: number, maxX: number): TabSegment[] {
  const cells: { text: string; action: TabAction; row: TabRow | null; num?: string; title?: string; mark?: string; close?: string }[] = rows.map((r, i) => {
    const title = r.title.length > TITLE_MAX ? r.title.slice(0, TITLE_MAX - 1) + "…" : r.title;
    const num = ` ${i + 1} `;
    const mark = tabMark(r);
    // The active cell (when there's more than one tab) carries a close ×; the
    // trailing space is part of the `close` part so the four parts always
    // concatenate to exactly `text`.
    const close = r.active && rows.length > 1 ? " × " : " ";
    return { text: `${num}${title}${mark}${close}`, action: { type: "switch", n: i + 1 }, row: r, num, title, mark, close };
  });
  const plus = { text: " + ", action: { type: "new" } as TabAction, row: null };

  // Reserve the + cell, then admit tab cells in order while they fit; if the
  // active tab would be dropped, evict inactive cells before it until it fits.
  const budget = maxX - left - (displayWidth(plus.text) + GAP);
  const kept: typeof cells = [];
  let used = 0;
  for (const c of cells) {
    const w = displayWidth(c.text) + GAP;
    if (used + w <= budget) {
      kept.push(c);
      used += w;
      continue;
    }
    if (c.row?.active) {
      while (kept.length && used + w > budget) {
        const evicted = kept.pop()!;
        used -= displayWidth(evicted.text) + GAP;
      }
      if (used + w <= budget) {
        kept.push(c);
        used += w;
      }
    }
  }
  kept.push(plus);

  const segs: TabSegment[] = [];
  let x = left;
  for (const c of kept) {
    const w = displayWidth(c.text);
    if (x + w > maxX) break;
    const hasClose = !!c.close && c.close.includes("×");
    segs.push({
      text: c.text, x0: x, x1: x + w, action: c.action, row: c.row,
      num: c.num, title: c.title, mark: c.mark, close: c.close,
      closeX0: hasClose ? x + displayWidth(`${c.num}${c.title}${c.mark}`) : undefined,
    });
    x += w + GAP;
  }
  return segs;
}

/** The segment under a 0-based column, if any. */
export function tabBarHit(segs: TabSegment[], x: number): TabAction | null {
  for (const s of segs) {
    if (x < s.x0 || x >= s.x1) continue;
    // The active cell's trailing ` × ` closes the tab instead of re-selecting it.
    if (s.closeX0 != null && x >= s.closeX0) return { type: "close" };
    return s.action;
  }
  return null;
}

// ── tab names ─────────────────────────────────────────────────────────────────
// New tabs are named from Boo's wardrobe — the personas and palettes of the
// mascot gallery — instead of "tab-2". Short, filesystem/branch-safe, and
// they make worktree dirs (.gearbox/tabs/wizard) and branches (tab/wizard)
// read like a crew instead of a counter. Pure; the conductor passes the names
// already taken (open tabs + dirs on disk).
export const TAB_NAMES = [
  "wizard", "skater", "pirate", "ninja", "chef", "astronaut", "cowboy", "graduate", "superhero",
  "mint", "golden", "ember", "void", "ice", "pink", "slate", "party", "crown",
] as const;

export function nextTabName(taken: Iterable<string>, id: number): string {
  const used = new Set([...taken].map((t) => t.toLowerCase()));
  for (const n of TAB_NAMES) if (!used.has(n)) return n;
  return `tab-${id}`; // the whole wardrobe is in use — fall back to the counter
}
