import { test, expect } from "bun:test";
import { statusBarLayout, statusBarHit, fitStatusFields } from "../src/ui/components/StatusBar.tsx";

// The footer is KEYS LEFT, MODEL + COST RIGHT. The right segment is `<model>` (+
// `  ·  $cost`), right-aligned to the 1-col right padding. So the model zone starts
// at width − 1 − rightLen. Zones are 0-based, half-open [start, end) terminal cols.

test("model zone is right-aligned (no cost)", () => {
  // width 100, "haiku" (5) → start = 100 - 1 - 5 = 94
  const { modelZone } = statusBarLayout({ model: "haiku", width: 100 });
  expect(modelZone).toEqual([94, 99]);
});

test("a cost suffix pushes the model zone further left", () => {
  // "sonnet"(6) + "  ·  "(5) + "$0.44"(5) = 16 → start = 100 - 1 - 16 = 83
  const { modelZone } = statusBarLayout({ model: "sonnet", costText: "$0.44", width: 100 });
  expect(modelZone).toEqual([83, 89]);
});

// statusBarHit resolves an SGR click (1-based x/y) to the model label. The status
// row sits above the composer: composer = marginTop(1) + rule(1) + policy(1) +
// input(composerLines), so statusRow = termRows - composerLines - paletteRows - 3.
const base = { termRows: 40, composerLines: 1, paletteRows: 0, model: "sonnet", costText: "$0.44", width: 100 };

test("click on the model label hits 'model' on the computed status row", () => {
  // statusRow = 40 - 1 - 0 - 3 = 36; model zone [83,89) → x = col+1 = 84..89
  expect(statusBarHit({ ...base, x: 84, y: 36 })).toBe("model");
  expect(statusBarHit({ ...base, x: 89, y: 36 })).toBe("model"); // col 88, last model col
});

test("click just past the model label (the separator) misses", () => {
  expect(statusBarHit({ ...base, x: 90, y: 36 })).toBeNull(); // col 89 = end (exclusive)
  expect(statusBarHit({ ...base, x: 83, y: 36 })).toBeNull(); // col 82 = before start
});

test("click off the status row misses", () => {
  expect(statusBarHit({ ...base, x: 84, y: 35 })).toBeNull();
  expect(statusBarHit({ ...base, x: 84, y: 37 })).toBeNull();
});

test("a multi-line composer raises the status row", () => {
  // composerLines = 3 → statusRow = 40 - 3 - 0 - 3 = 34
  expect(statusBarHit({ ...base, composerLines: 3, x: 84, y: 34 })).toBe("model");
  expect(statusBarHit({ ...base, composerLines: 3, x: 84, y: 36 })).toBeNull();
});

test("an open palette raises the status row by paletteRows", () => {
  // paletteRows = 5 → statusRow = 40 - 1 - 5 - 3 = 31
  expect(statusBarHit({ ...base, paletteRows: 5, x: 84, y: 31 })).toBe("model");
});

test("no model label means no hit", () => {
  expect(statusBarHit({ ...base, model: "", x: 84, y: 36 })).toBeNull();
});

test("fitStatusFields keeps the first field and sheds lowest-priority ones to fit width", () => {
  const fields = [
    { text: "sonnet-4.6", priority: 100 },
    { text: "effort medium", priority: 50 },
    { text: "⎇ main", priority: 40 },
    { text: "80.0k tok", priority: 30 },
    { text: "$0.44", priority: 20 },
    { text: "1% ctx", priority: 60 },
  ];
  expect(fitStatusFields(fields, 1000).map((f) => f.text)).toEqual(fields.map((f) => f.text));
  const tight = fitStatusFields(fields, 30).map((f) => f.text);
  expect(tight[0]).toBe("sonnet-4.6");
  expect(tight).not.toContain("$0.44");
  expect(tight).not.toContain("80.0k tok");
  expect(fitStatusFields(fields, 3).map((f) => f.text)).toEqual(["sonnet-4.6"]);
});
