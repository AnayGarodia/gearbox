// The clickable masthead tab bar: pure layout + hit-test (the Masthead renders
// from these segments and App's mouse handler hit-tests with them — one truth).
import { test, expect } from "bun:test";
import { tabBarSegments, tabBarHit, tabMark, type TabRow } from "../src/ui/tabbar.ts";

const row = (title: string, o: Partial<TabRow> = {}): TabRow => ({ title, active: false, busy: false, needsInput: false, ...o });

test("segments lay out left to right with a + cell last", () => {
  const segs = tabBarSegments([row("main", { active: true }), row("fix", { busy: true })], 10, 80);
  expect(segs).toHaveLength(3);
  expect(segs[0]!.text).toBe(" 1 main × "); // active cell carries the close ×
  expect(segs[1]!.text).toBe(" 2 fix● ");
  expect(segs[2]!.text).toBe(" + ");
  expect(segs[0]!.x0).toBe(10);
  // contiguous with a 1-col gap
  expect(segs[1]!.x0).toBe(segs[0]!.x1 + 1);
  expect(segs[2]!.x0).toBe(segs[1]!.x1 + 1);
});

test("needs-input mark beats busy; long titles truncate", () => {
  expect(tabMark(row("x", { busy: true, needsInput: true }))).toBe("⚠");
  const segs = tabBarSegments([row("a-very-long-session-title")], 0, 80);
  expect(segs[0]!.text).toBe(" 1 a-very-long-s… ");
});

test("the + cell always fits; the active tab survives a narrow bar", () => {
  const rows = [row("alpha"), row("bravo"), row("charlie", { active: true })];
  const segs = tabBarSegments(rows, 10, 34); // room for ~1 tab + plus
  expect(segs.some((s) => s.action.type === "new")).toBe(true);
  expect(segs.some((s) => s.row?.active)).toBe(true); // charlie evicted alpha/bravo
});

test("hit-test maps columns to actions; gaps miss", () => {
  const segs = tabBarSegments([row("main"), row("fix")], 10, 80);
  expect(tabBarHit(segs, segs[0]!.x0)).toEqual({ type: "switch", n: 1 });
  expect(tabBarHit(segs, segs[1]!.x1 - 1)).toEqual({ type: "switch", n: 2 });
  expect(tabBarHit(segs, segs[2]!.x0 + 1)).toEqual({ type: "new" });
  expect(tabBarHit(segs, segs[0]!.x1)).toBeNull(); // the gap between cells
  expect(tabBarHit(segs, 0)).toBeNull(); // the wordmark
});

// ── wardrobe names ────────────────────────────────────────────────────────────
import { nextTabName, TAB_NAMES } from "../src/ui/tabbar.ts";

test("nextTabName dresses tabs from Boo's wardrobe, skipping taken names", () => {
  expect(nextTabName([], 2)).toBe("wizard");
  expect(nextTabName(["wizard"], 3)).toBe("skater");
  expect(nextTabName(["Wizard", "skater", "pirate"], 4)).toBe("ninja"); // case-insensitive
});

test("nextTabName falls back to the counter when the wardrobe is exhausted", () => {
  expect(nextTabName([...TAB_NAMES], 7)).toBe("tab-7");
});

test("segments expose styled parts that concatenate to the hit-test text", () => {
  const segs = tabBarSegments([{ title: "wizard", active: true, busy: true, needsInput: false }], 10, 120);
  const cell = segs[0]!;
  expect(`${cell.num}${cell.title}${cell.mark}${cell.close}`).toBe(cell.text);
  expect(cell.close).toBe(" "); // single tab: nothing to close, no ×
  expect(cell.closeX0).toBeUndefined();
});

test("the active cell's × closes; the rest of the cell still switches", () => {
  const segs = tabBarSegments([row("main"), row("wizard", { active: true })], 10, 120);
  const active = segs[1]!;
  expect(active.text.endsWith(" × ")).toBe(true);
  expect(active.closeX0).toBeGreaterThan(active.x0);
  expect(tabBarHit(segs, active.x0)).toEqual({ type: "switch", n: 2 }); // title area
  expect(tabBarHit(segs, active.closeX0! + 1)).toEqual({ type: "close" }); // the ×
  // inactive cells never grow a close zone
  expect(segs[0]!.closeX0).toBeUndefined();
  expect(segs[0]!.text).toBe(" 1 main ");
});

test("done (finished-while-hidden) shows ✓ and is outranked only by needs-input", () => {
  expect(tabMark(row("x", { done: true }))).toBe("✓");
  expect(tabMark(row("x", { done: true, busy: true }))).toBe("✓");
  expect(tabMark(row("x", { done: true, needsInput: true }))).toBe("⚠");
  const segs = tabBarSegments([row("fix", { done: true })], 0, 80);
  expect(segs[0]!.text).toBe(" 1 fix✓ ");
});

test("mastheadAccountZone right-aligns to the padding and yields to a crowded bar", async () => {
  const { mastheadAccountZone } = await import("../src/ui/components/Masthead.tsx");
  const rows = [row("main", { active: true })];
  const zone = mastheadAccountZone("claude · Max · a@b.co", rows, 100)!;
  expect(zone[1]).toBe(99); // ends at width − 1 (the right padding col)
  expect(zone[1] - zone[0]).toBe("claude · Max · a@b.co".length);
  // Narrow bar: no room → no zone (the render hides the account too).
  expect(mastheadAccountZone("claude · Max · a@b.co", [row("alpha"), row("bravo"), row("charlie", { active: true })], 46)).toBeNull();
  expect(mastheadAccountZone(null, rows, 100)).toBeNull();
});

test("the busy ● shows only on hidden tabs — never on the active one", () => {
  expect(tabMark(row("x", { busy: true, active: true }))).toBe("");
  expect(tabMark(row("x", { busy: true, active: false }))).toBe("●");
});
