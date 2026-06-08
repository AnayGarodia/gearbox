import React from "react";
import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { StatusBar } from "../src/ui/components/StatusBar.tsx";

const base = { model: "claude", ctxPct: 10, width: 100 };

test("footer shows the model on the right and a key legend on the left", () => {
  const out = render(<StatusBar {...base} />).lastFrame() ?? "";
  expect(out).toContain("claude"); // model, right side
  expect(out).toContain("commands"); // key legend, left side
  expect(out).toContain("send");
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

test("context appears ONLY when low (≤15% left ⇒ ctxPct ≥ 85), as an amber chip", () => {
  const fine = render(<StatusBar {...base} ctxPct={40} />).lastFrame() ?? "";
  expect(fine).not.toContain("ctx");
  const low = render(<StatusBar {...base} ctxPct={92} />).lastFrame() ?? "";
  expect(low).toContain("8% ctx left"); // remaining, not used
});
