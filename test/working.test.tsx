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

test("the now block is a single line — no mascot, no duplicate activity log", () => {
  const out = render(<Working {...base} verb="Editing" />).lastFrame() ?? "";
  expect(out).not.toContain("▀"); // no sprite cells
  expect(out).not.toContain("▸"); // the live-steps row is gone (it streams in the transcript)
  // just the verb now-row (one non-empty line)
  expect(out.split("\n").filter((l) => l.trim().length > 0).length).toBe(1);
});

test("a blocking prompt flips the now-row to 'waiting for you'", () => {
  const out = render(<Working {...base} verb="Thinking" waiting />).lastFrame() ?? "";
  expect(out).toContain("waiting for you");
  expect(out).not.toContain("esc interrupt");
});

test("workingRows matches what renders (the App footer estimate reads it)", () => {
  expect(workingRows(true)).toBe(2); // marginTop + now-row
  expect(workingRows(false)).toBe(2); // marginTop + verdict (linger)
});

test("the linger beat shows a verdict label, not the timer", () => {
  const out = render(<Working {...base} verb="done" linger state="celebrate" />).lastFrame() ?? "";
  expect(out).toContain("done");
  expect(out).not.toContain("esc interrupt");
  const err = render(<Working {...base} verb="x" linger state="error" />).lastFrame() ?? "";
  expect(err).toContain("something broke");
});
