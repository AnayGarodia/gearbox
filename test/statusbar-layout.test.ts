import { test, expect } from "bun:test";
import { statusBarLayout, statusBarHit, fitStatusFields } from "../src/ui/components/StatusBar.tsx";

// The meter is WHERE LEFT, MODEL + GAUGE + COST RIGHT. The right segment is
// `<model>` (+ `  ·  █████ ctx`) (+ `  ·  $cost`), right-aligned to the 1-col
// right padding. So the model zone starts at width − 1 − rightLen. Zones are
// 0-based, half-open [start, end) terminal cols.

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

test("the context gauge pushes the model zone further left (5 cells + ' ctx' = 9)", () => {
  // "sonnet"(6) + "  ·  "(5) + "█████ ctx"(9) + "  ·  "(5) + "$0.44"(5) = 30 → start = 100 - 1 - 30 = 69
  const { modelZone } = statusBarLayout({ model: "sonnet", costText: "$0.44", ctxPct: 40, width: 100 });
  expect(modelZone).toEqual([69, 75]);
  // a null ctxPct means no gauge — identical to omitting it
  expect(statusBarLayout({ model: "sonnet", costText: "$0.44", ctxPct: null, width: 100 }).modelZone).toEqual([83, 89]);
});

test("statusBarHit accounts for the gauge in the right segment", () => {
  // the meter is the BOTTOM row now: y = termRows; model zone [69,75) → x = 70..75
  const args = { termRows: 40, composerLines: 1, paletteRows: 0, model: "sonnet", costText: "$0.44", ctxPct: 40, width: 100 };
  expect(statusBarHit({ ...args, x: 70, y: 40 })).toBe("model");
  expect(statusBarHit({ ...args, x: 84, y: 40 })).toBe("context"); // the gauge is a door to /context now
});

// statusBarHit resolves an SGR click (1-based x/y) to the model label. The METER
// is the frame's bottom edge (App renders it last), so the hit row is simply the
// terminal's last row — independent of composer height and palettes.
const base = { termRows: 40, composerLines: 1, paletteRows: 0, model: "sonnet", costText: "$0.44", width: 100 };

test("click on the model label hits 'model' on the bottom row", () => {
  // y = termRows = 40; model zone [83,89) → x = col+1 = 84..89
  expect(statusBarHit({ ...base, x: 84, y: 40 })).toBe("model");
  expect(statusBarHit({ ...base, x: 89, y: 40 })).toBe("model"); // col 88, last model col
});

test("click just past the model label (the separator) misses", () => {
  expect(statusBarHit({ ...base, x: 90, y: 40 })).toBeNull(); // col 89 = end (exclusive)
  expect(statusBarHit({ ...base, x: 83, y: 40 })).toBeNull(); // col 82 = before start
});

test("click off the bottom row misses", () => {
  expect(statusBarHit({ ...base, x: 84, y: 39 })).toBeNull();
  expect(statusBarHit({ ...base, x: 84, y: 38 })).toBeNull();
});

test("composer height no longer moves the meter (it is the bottom edge)", () => {
  expect(statusBarHit({ ...base, composerLines: 3, x: 84, y: 40 })).toBe("model");
  expect(statusBarHit({ ...base, composerLines: 3, x: 84, y: 36 })).toBeNull();
});

test("an open palette does not move the meter either", () => {
  expect(statusBarHit({ ...base, paletteRows: 5, x: 84, y: 40 })).toBe("model");
});

test("no model label means no hit", () => {
  expect(statusBarHit({ ...base, model: "", x: 84, y: 40 })).toBeNull();
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

test("every meter fact is a door: gauge → context, $ → cost, cwd:branch → where", () => {
  const args = { termRows: 40, composerLines: 1, paletteRows: 0, model: "sonnet", costText: "$0.44", ctxPct: 40, width: 100, where: "~/proj:main", chipLen: 0 };
  const { modelZone, gaugeZone, costZone, whereZone } = statusBarLayout(args);
  expect(gaugeZone![0]).toBe(modelZone[1] + 5); // "  ·  " separator
  expect(costZone![1]).toBe(99); // right-aligned to the 1-col padding
  expect(whereZone).toEqual([1, 1 + "~/proj:main".length]);
  expect(statusBarHit({ ...args, x: costZone![0] + 1, y: 40 })).toBe("cost");
  expect(statusBarHit({ ...args, x: 2, y: 40 })).toBe("where");
  expect(statusBarHit({ ...args, x: whereZone![1] + 2, y: 40 })).toBeNull(); // the gap after the path
});

test("where truncates against chips + right segment exactly like the render", () => {
  const long = "~/a/very/long/project/path/that/keeps/going:feature-branch";
  const { whereZone, whereShown } = statusBarLayout({ model: "sonnet", costText: "$0.44", ctxPct: 40, width: 60, where: long, chipLen: 10 });
  expect(whereShown.length).toBeLessThan(long.length);
  expect(whereShown.endsWith("…")).toBe(true);
  expect(whereZone).toEqual([1, 1 + whereShown.length]);
});
