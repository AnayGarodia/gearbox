import React from "react";
import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { Masthead, tabStripLayout, tabStripHit, MASTHEAD_TAB_COL } from "../src/ui/components/TabStrip.tsx";

test("tabStripLayout lays the four pills out left-to-right after the wordmark", () => {
  const z = tabStripLayout();
  expect(z.map((t) => t.tab)).toEqual(["session", "routing", "providers", "cost"]);
  // Tabs start after `gearbox` + 2-space gap: col 1 (pad) + 7 + 2 = 10.
  expect(MASTHEAD_TAB_COL).toBe(10);
  // " session " is 9 cols (7 + 1 pad each side) at col 10..18 → end 19 (exclusive)
  expect(z[0]).toEqual({ tab: "session", start: 10, end: 19 });
  expect(z[1]!.start).toBe(20); // 19 + 1-space gap
});

test("tabStripHit maps a click to the tab on the masthead row, null elsewhere", () => {
  const ROW = 2; // masthead row (marginTop is row 1)
  expect(tabStripHit(11, ROW, ROW)).toBe("session"); // col 10, inside the session pill
  expect(tabStripHit(21, ROW, ROW)).toBe("routing"); // col 20, start of the routing pill
  expect(tabStripHit(20, ROW, ROW)).toBeNull(); // col 19 = gap between pills
  expect(tabStripHit(11, ROW + 1, ROW)).toBeNull(); // wrong row
  expect(tabStripHit(2, ROW, ROW)).toBeNull(); // the wordmark is not a tab
});

test("Masthead renders the wordmark, all four tabs, and the account on one strip", () => {
  const out = render(<Masthead active="cost" account="claude · Max" width={100} />).lastFrame() ?? "";
  expect(out).toContain("gearbox");
  expect(out).toContain("session");
  expect(out).toContain("routing");
  expect(out).toContain("providers");
  expect(out).toContain("cost");
  expect(out).toContain("claude · Max");
  expect(out).toContain("─"); // the hairline rule under the masthead row
});

test("Masthead hides the tabs during setup (showTabs=false)", () => {
  const out = render(<Masthead active="session" width={100} showTabs={false} />).lastFrame() ?? "";
  expect(out).toContain("gearbox");
  expect(out).not.toContain("routing");
});
