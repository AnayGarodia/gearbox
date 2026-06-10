import React from "react";
import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { Working, workingRows } from "../src/ui/components/Working.tsx";

const base = { state: "tool" as const, elapsed: 3, width: 100 };

test("the now block keeps the verb and 'esc interrupt' visible", () => {
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

test("no mascot while live — rows belong to the transcript (Boo lives on home)", () => {
  const out = render(<Working {...base} verb="Editing" action="running tests  · 12s" trail="✓ read  ✓ edit" />).lastFrame() ?? "";
  expect(out).not.toContain("▀"); // no sprite cells
  expect(out).toContain("running tests");
  expect(out).toContain("✓ read");
  // verb row + activity row only
  expect(out.split("\n").filter((l) => l.trim().length > 0).length).toBe(2);
});

test("workingRows matches what renders (the App footer estimate reads it)", () => {
  expect(workingRows(true)).toBe(3); // marginTop + verb + activity
  expect(workingRows(false)).toBe(2); // marginTop + verdict (linger)
});

test("the linger beat shows a verdict label, not the timer", () => {
  const out = render(<Working {...base} verb="done" linger state="celebrate" />).lastFrame() ?? "";
  expect(out).toContain("done");
  expect(out).not.toContain("esc interrupt");
  const err = render(<Working {...base} verb="x" linger state="error" />).lastFrame() ?? "";
  expect(err).toContain("something broke");
});
