// The clickable masthead tab bar: pure layout + hit-test (the Masthead renders
// from these segments and App's mouse handler hit-tests with them — one truth).
import { test, expect } from "bun:test";
import { tabBarSegments, tabBarHit, tabMark, type TabRow } from "../src/ui/tabbar.ts";

const row = (title: string, o: Partial<TabRow> = {}): TabRow => ({ title, active: false, busy: false, needsInput: false, ...o });

test("segments lay out left to right with a + cell last", () => {
  const segs = tabBarSegments([row("main", { active: true }), row("fix", { busy: true })], 10, 80);
  expect(segs).toHaveLength(3);
  expect(segs[0]!.text).toBe(" 1 main ");
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
