import React from "react";
import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { StatusBar } from "../src/ui/components/StatusBar.tsx";

const base = { model: "claude", ctxPct: 10, width: 100 };

test("the meter shows the model on the right and cwd:branch on the left (wordmark lives in the masthead)", () => {
  const out = render(<StatusBar {...base} cwd="/Users/me/proj" branch="main" />).lastFrame() ?? "";
  expect(out).toContain("claude"); // model, right side
  expect(out).not.toContain("gearbox"); // the wordmark moved to the masthead
  expect(out).toContain("/Users/me/proj:main"); // where you are
});

test("session cost appears only once it rounds to a visible cent", () => {
  const cheap = render(<StatusBar {...base} cost={0.004} />).lastFrame() ?? "";
  expect(cheap).not.toContain("$"); // a subscription seat / sub-cent turn shows no cost
  const real = render(<StatusBar {...base} cost={0.44} />).lastFrame() ?? "";
  expect(real).toContain("$0.44");
});

test("offline chip shows only when offline", () => {
  const on = render(<StatusBar {...base} online={true} />).lastFrame() ?? "";
  expect(on).not.toContain("offline");
  const off = render(<StatusBar {...base} online={false} />).lastFrame() ?? "";
  expect(off).toContain("offline");
});

test("yolo chip shows only under yolo", () => {
  const off = render(<StatusBar {...base} />).lastFrame() ?? "";
  expect(off).not.toContain("yolo");
  const on = render(<StatusBar {...base} yolo={true} />).lastFrame() ?? "";
  expect(on).toContain("yolo");
});

test("the context gauge shows whenever a context % is known (5 cells + 'ctx'), and never without one", () => {
  const none = render(<StatusBar {...base} ctxPct={null} />).lastFrame() ?? "";
  expect(none).not.toContain("ctx");
  const fine = render(<StatusBar {...base} ctxPct={40} />).lastFrame() ?? "";
  expect(fine).toContain("ctx"); // gauge present even when healthy (severity = color, not visibility)
  expect(fine).toContain("██"); // ~2 of 5 cells filled at 40%
  expect(fine).toContain("░");
  const low = render(<StatusBar {...base} ctxPct={92} />).lastFrame() ?? "";
  expect(low).toContain("ctx");
  expect(low).not.toContain("ctx left"); // the old amber chip wording is gone — the gauge IS the notice
});
