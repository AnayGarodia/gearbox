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
}

export type TabAction = { type: "switch"; n: number } | { type: "new" };

export interface TabSegment {
  text: string; // rendered cell text (marker included)
  x0: number; // 0-based start column, inclusive
  x1: number; // 0-based end column, exclusive
  action: TabAction;
  row: TabRow | null; // null for the + cell
}

const TITLE_MAX = 14;
const GAP = 1; // columns between cells

/** Status marker rendered after the title: needs-input beats busy. */
export const tabMark = (r: TabRow): string => (r.needsInput ? "⚠" : r.busy ? "●" : "");

/**
 * Lay the cells out from column `left` (0-based), never past `maxX`. Cells that
 * don't fit are dropped from the END except the + cell, which always fits last
 * (it's the affordance the bar exists for). The ACTIVE tab is never dropped:
 * when space runs out, trailing inactive tabs go first.
 */
export function tabBarSegments(rows: TabRow[], left: number, maxX: number): TabSegment[] {
  const cells: { text: string; action: TabAction; row: TabRow | null }[] = rows.map((r, i) => {
    const title = r.title.length > TITLE_MAX ? r.title.slice(0, TITLE_MAX - 1) + "…" : r.title;
    return { text: ` ${i + 1} ${title}${tabMark(r)} `, action: { type: "switch", n: i + 1 }, row: r };
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
    segs.push({ text: c.text, x0: x, x1: x + w, action: c.action, row: c.row });
    x += w + GAP;
  }
  return segs;
}

/** The segment under a 0-based column, if any. */
export function tabBarHit(segs: TabSegment[], x: number): TabAction | null {
  for (const s of segs) if (x >= s.x0 && x < s.x1) return s.action;
  return null;
}
