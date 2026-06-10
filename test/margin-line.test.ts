import { test, expect } from "bun:test";
import { marginLine, marginWidth, MARGIN_W, type Span } from "../src/ui/lines.ts";

const w = (l: Span[]) => l.reduce((n, s) => n + s.text.length, 0);

test("marginLine right-aligns figures in the margin column on a wide page", () => {
  const line = marginLine([{ text: "  ∟  edit  src/foo.ts" }], [{ text: "1.2s" }, { text: "+3" }], 92);
  expect(w(line)).toBe(92); // body padded + figures flush to the right edge
  const text = line.map((s) => s.text).join("");
  expect(text.endsWith("1.2s · +3")).toBe(true);
  expect(text.startsWith("  ∟  edit  src/foo.ts")).toBe(true);
});

test("marginLine folds figures inline below the margin threshold", () => {
  expect(marginWidth(80)).toBe(0);
  const line = marginLine([{ text: "step" }], [{ text: "4s" }], 80);
  expect(line.map((s) => s.text).join("")).toBe("step  · 4s");
});

test("marginLine never exceeds width (long body, wide figures)", () => {
  const long = "x".repeat(200);
  for (const width of [92, 100, 88, 87, 40]) {
    expect(w(marginLine([{ text: long }], [{ text: "12m 30s" }, { text: "$0.44" }], width))).toBeLessThanOrEqual(width);
  }
});

test("marginLine without figures is just the clipped body", () => {
  const line = marginLine([{ text: "hello" }], [], 92);
  expect(line.map((s) => s.text).join("")).toBe("hello");
  expect(MARGIN_W).toBe(16);
});
