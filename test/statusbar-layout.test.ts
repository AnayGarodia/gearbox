import { test, expect } from "bun:test";
import { statusBarLayout, statusBarHit } from "../src/ui/components/StatusBar.tsx";

// The status bar left segment is: paddingX(1) + optional "{mode}  ·  " + model
// + optional "  ·  effort {effort}". sep is "  ·  " (5 cols). Zones are 0-based,
// half-open [start, end) terminal columns.

test("model zone follows the 1-col left pad when no mode prefix", () => {
  const { modelZone } = statusBarLayout({ model: "haiku", effort: undefined, mode: "normal" });
  expect(modelZone).toEqual([1, 6]); // cols 1..5 hold "haiku"
});

test("mode prefix shifts the model zone right by '{mode}  ·  '", () => {
  // "plan" (4) + "  ·  " (5) = 9, after the 1-col pad → model starts at col 10
  const { modelZone } = statusBarLayout({ model: "haiku", effort: undefined, mode: "plan" });
  expect(modelZone).toEqual([10, 15]);
});

test("effort zone sits after the model + separator", () => {
  // pad(1) + "sonnet"(6) → model [1,7); sep "  ·  "(5) → effort label "effort max"(10)
  const { modelZone, effortZone } = statusBarLayout({ model: "sonnet", effort: "max", mode: "normal" });
  expect(modelZone).toEqual([1, 7]);
  expect(effortZone).toEqual([12, 22]);
});

test("no effort label means no effort zone", () => {
  const { effortZone } = statusBarLayout({ model: "haiku", effort: undefined, mode: "normal" });
  expect(effortZone).toBeNull();
});

// statusBarHit resolves an SGR click (1-based x/y) to the model/effort label.
// The status-bar row sits above the composer: composer = marginTop(1) + rule(1)
// + input(composerLines), the input's bottom line is the last terminal row, and
// the palette box (paletteRows) sits between the status bar and the composer.
// So statusRow (1-based) = termRows - composerLines - paletteRows - 2.
const base = { termRows: 40, composerLines: 1, paletteRows: 0, model: "sonnet", effort: "max", mode: "normal" as const };

test("click on the model label hits 'model' on the computed status row", () => {
  // statusRow = 40 - 1 - 0 - 2 = 37; model zone is col [1,7), so x = col+1 = 2..7
  expect(statusBarHit({ ...base, x: 2, y: 37 })).toBe("model");
  expect(statusBarHit({ ...base, x: 7, y: 37 })).toBe("model"); // col 6, last model col
});

test("click on the effort label hits 'effort'", () => {
  // effort zone col [12,22) → x = 13..22
  expect(statusBarHit({ ...base, x: 13, y: 37 })).toBe("effort");
});

test("click off the status row misses", () => {
  expect(statusBarHit({ ...base, x: 2, y: 36 })).toBeNull();
  expect(statusBarHit({ ...base, x: 2, y: 38 })).toBeNull();
});

test("click between the labels misses", () => {
  // col 8..11 is the separator between model and effort → x = 9..12
  expect(statusBarHit({ ...base, x: 9, y: 37 })).toBeNull();
});

test("a multi-line composer raises the status row", () => {
  // composerLines = 3 → statusRow = 40 - 3 - 0 - 2 = 35
  expect(statusBarHit({ ...base, composerLines: 3, x: 2, y: 35 })).toBe("model");
  expect(statusBarHit({ ...base, composerLines: 3, x: 2, y: 37 })).toBeNull();
});

test("an open palette raises the status row by paletteRows", () => {
  // paletteRows = 5 → statusRow = 40 - 1 - 5 - 2 = 32
  expect(statusBarHit({ ...base, paletteRows: 5, x: 2, y: 32 })).toBe("model");
});

test("no effort label means effort clicks miss", () => {
  expect(statusBarHit({ ...base, effort: undefined, x: 13, y: 37 })).toBeNull();
});
