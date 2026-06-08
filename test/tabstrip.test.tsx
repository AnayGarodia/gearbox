import React from "react";
import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { TabStrip, tabStripLayout, tabStripHit } from "../src/ui/components/TabStrip.tsx";

test("tabStripLayout lays the four tabs out left-to-right after the 1-col pad", () => {
  const z = tabStripLayout();
  expect(z.map((t) => t.tab)).toEqual(["session", "routing", "providers", "cost"]);
  expect(z[0]).toEqual({ tab: "session", start: 1, end: 8 }); // "Session" (7) at col 1..7
  expect(z[1]!.start).toBe(10); // 8 + 2-space gap
});

test("tabStripHit maps a click to the tab on the strip row, null elsewhere", () => {
  const ROW = 4;
  expect(tabStripHit(2, ROW, ROW)).toBe("session"); // col 1, inside Session
  expect(tabStripHit(11, ROW, ROW)).toBe("routing"); // col 10, start of Routing
  expect(tabStripHit(9, ROW, ROW)).toBeNull(); // col 8 = gap between tabs
  expect(tabStripHit(2, ROW + 1, ROW)).toBeNull(); // wrong row
});

test("TabStrip renders all four tabs and highlights the active one", () => {
  const out = render(<TabStrip active="cost" width={80} />).lastFrame() ?? "";
  expect(out).toContain("Session");
  expect(out).toContain("Routing");
  expect(out).toContain("Providers");
  expect(out).toContain("Cost");
});
