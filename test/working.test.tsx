import React from "react";
import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { Working, workingRows, WORKING_GHOST_MIN_W } from "../src/ui/components/Working.tsx";
import { STATE_GHOST_ROWS } from "../src/ui/components/Mascot.tsx";

const base = { state: "tool" as const, elapsed: 3, width: 100 };

test("the working block keeps the verb and 'esc interrupt' visible", () => {
  const out = render(<Working {...base} verb="Reading" />).lastFrame() ?? "";
  expect(out).toContain("Reading");
  expect(out).toContain("esc interrupt");
});

test("the figures (elapsed · esc) sit at the right edge of the block", () => {
  const out = render(<Working {...base} verb="Reading" />).lastFrame() ?? "";
  const row = (out.split("\n").find((l) => l.includes("esc interrupt")) ?? "");
  // Right-aligned within the page column: the row ends at/near the given width.
  expect(row.trimEnd().length).toBeGreaterThan(80);
});

test("Boo IS the indicator on wide frames: the head-crop ghost renders beside the verb", () => {
  const out = render(<Working {...base} verb="Editing" />).lastFrame() ?? "";
  expect(out).toContain("▀"); // half-block sprite cells = the ghost is present
  expect(out).not.toContain("context left"); // the meter's gauge carries low-context
  // Block height = the fixed ghost crop (every state, so the composer never shifts).
  expect(out.split("\n").filter((l) => l.trim().length > 0).length).toBe(STATE_GHOST_ROWS);
});

test("narrow frames drop the ghost and keep the one-line now row", () => {
  const out = render(<Working {...base} width={WORKING_GHOST_MIN_W - 1} verb="Editing" />).lastFrame() ?? "";
  expect(out).not.toContain("▀");
  expect(out).toContain("Editing");
  expect(out.split("\n").filter((l) => l.trim().length > 0).length).toBe(1);
});

test("workingRows matches what renders (the App footer estimate reads it)", () => {
  expect(workingRows(100)).toBe(1 + STATE_GHOST_ROWS);
  expect(workingRows(WORKING_GHOST_MIN_W - 1)).toBe(2);
});

test("the linger beat shows a label, not the timer — ghost still present", () => {
  const out = render(<Working {...base} verb="done" linger state="celebrate" />).lastFrame() ?? "";
  expect(out).toContain("done");
  expect(out).not.toContain("esc interrupt");
  expect(out).toContain("▀"); // the celebrate beat IS Boo's confetti moment
});
