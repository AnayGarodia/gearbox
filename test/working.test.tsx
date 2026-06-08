import React from "react";
import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { Working } from "../src/ui/components/Working.tsx";

const base = { state: "tool" as const, elapsed: 3, width: 100 };

test("the live status line keeps the verb and 'esc to interrupt' visible", () => {
  const out = render(<Working {...base} verb="Reading" />).lastFrame() ?? "";
  expect(out).toContain("Reading");
  expect(out).toContain("esc to interrupt");
});

test("low-context notice appears only when context is genuinely low (≥85% used)", () => {
  const fine = render(<Working {...base} verb="Editing" ctxPct={40} />).lastFrame() ?? "";
  expect(fine).not.toContain("context left");
  const low = render(<Working {...base} verb="Editing" ctxPct={92} />).lastFrame() ?? "";
  expect(low).toContain("8% context left");
  expect(low).toContain("/compact");
});

test("no low-context notice during the post-turn linger beat", () => {
  const out = render(<Working {...base} verb="done" linger ctxPct={95} />).lastFrame() ?? "";
  expect(out).not.toContain("context left");
});
