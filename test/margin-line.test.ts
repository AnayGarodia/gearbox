import { test, expect } from "bun:test";
import { marginLine, marginWidth, MARGIN_W, type Span } from "../src/ui/lines.ts";

const w = (l: Span[]) => l.reduce((n, s) => n + s.text.length, 0);

test("marginLine folds figures inline even on a wide page (no telemetry margin)", () => {
  // Quiet Workshop: the right-aligned margin column is gone. Figures always fold
  // inline as a faint ` · fig · fig` tail beside the fact they belong to.
  expect(marginWidth(92)).toBe(0);
  const line = marginLine([{ text: "  ⏺  Edit(src/foo.ts)" }], [{ text: "1.2s" }, { text: "+3" }], 92);
  const text = line.map((s) => s.text).join("");
  expect(text).toBe("  ⏺  Edit(src/foo.ts)  · 1.2s · +3");
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
