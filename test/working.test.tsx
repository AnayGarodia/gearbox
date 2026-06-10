import React from "react";
import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { Working } from "../src/ui/components/Working.tsx";

const base = { state: "tool" as const, elapsed: 3, width: 100 };

test("the now row keeps the verb and 'esc interrupt' visible", () => {
  const out = render(<Working {...base} verb="Reading" />).lastFrame() ?? "";
  expect(out).toContain("Reading");
  expect(out).toContain("esc interrupt");
});

test("the figures (elapsed · esc) sit at the right edge of the row", () => {
  const out = render(<Working {...base} verb="Reading" />).lastFrame() ?? "";
  const row = (out.split("\n").find((l) => l.includes("esc interrupt")) ?? "");
  // Right-aligned within the page column: the row ends at/near the given width.
  expect(row.trimEnd().length).toBeGreaterThan(80);
});

test("the now row is exactly ONE row — no low-context notice under it (the meter's gauge carries that)", () => {
  const out = render(<Working {...base} verb="Editing" />).lastFrame() ?? "";
  expect(out).not.toContain("context left");
  // marginTop blank + the row itself
  expect(out.split("\n").filter((l) => l.trim().length > 0).length).toBe(1);
});

test("the linger beat shows a label, not the timer", () => {
  const out = render(<Working {...base} verb="done" linger state="celebrate" />).lastFrame() ?? "";
  expect(out).toContain("done");
  expect(out).not.toContain("esc interrupt");
});
