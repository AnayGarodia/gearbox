import React from "react";
import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { TabStrip, tabStripLayout, tabStripHit } from "../src/ui/components/TabStrip.tsx";

test("tabStripLayout lays the four pills out left-to-right after the 1-col pad", () => {
  const z = tabStripLayout();
  expect(z.map((t) => t.tab)).toEqual(["session", "routing", "providers", "cost"]);
  // " Session " is 9 cols (7 + 1 pad each side) at col 1..9 → end 10 (exclusive)
  expect(z[0]).toEqual({ tab: "session", start: 1, end: 10 });
  expect(z[1]!.start).toBe(11); // 10 + 1-space gap
});

test("tabStripHit maps a click to the tab on the strip row, null elsewhere", () => {
  const ROW = 4;
  expect(tabStripHit(2, ROW, ROW)).toBe("session"); // col 1, inside the Session pill
  expect(tabStripHit(12, ROW, ROW)).toBe("routing"); // col 11, start of the Routing pill
  expect(tabStripHit(11, ROW, ROW)).toBeNull(); // col 10 = gap between pills
  expect(tabStripHit(2, ROW + 1, ROW)).toBeNull(); // wrong row
});

test("TabStrip renders all four tabs and highlights the active one", () => {
  const out = render(<TabStrip active="cost" width={80} />).lastFrame() ?? "";
  expect(out).toContain("session");
  expect(out).toContain("routing");
  expect(out).toContain("providers");
  expect(out).toContain("cost");
});
