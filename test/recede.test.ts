import { test, expect } from "bun:test";
import { recedeLine, itemsToLines, type Line } from "../src/ui/lines.ts";
import { color } from "../src/ui/theme.ts";
import type { Item } from "../src/ui/types.ts";

// History recede (the working-moment mechanic): while busy / consent-pending,
// settled items dim so the now-row or consent line is the only bright thing.

test("recedeLine drops text ink one level and everything non-semantic to faint", () => {
  const line: Line = [
    { text: "body", color: color.text },
    { text: "quiet", color: color.dim },
    { text: "pad" }, // no color at all
    { text: "blue", color: color.path },
  ];
  const out = recedeLine(line);
  expect(out[0]!.color).toBe(color.dim); // text → dim
  expect(out[1]!.color).toBe(color.faint); // dim → faint
  expect(out[2]!.color).toBe(color.faint); // un-colored → faint
  expect(out[3]!.color).toBe(color.faint); // any other non-semantic → faint
});

test("recedeLine keeps the semantic colors (err/warn/ok/accent) so meaning survives", () => {
  const line: Line = [
    { text: "✗", color: color.err },
    { text: "⚠", color: color.warn },
    { text: "✓", color: color.ok },
    { text: "/cmd", color: color.accent, bold: true },
  ];
  const out = recedeLine(line);
  expect(out.map((s) => s.color)).toEqual([color.err, color.warn, color.ok, color.accent]);
  expect(out[3]!.bold).toBe(true); // styling other than color is untouched
});

const items: Item[] = [
  { kind: "user", id: 1, text: "old prompt", turnNo: 1 } as Item,
  { kind: "assistant", id: 2, text: "old reply", done: true } as Item,
  { kind: "user", id: 3, text: "new prompt", turnNo: 2 } as Item,
  { kind: "assistant", id: 4, text: "streaming reply" } as Item,
];

const textColors = (lines: Line[], needle: string) =>
  lines.flatMap((l) => l.filter((s) => s.text.includes(needle)).map((s) => s.color));

test("itemsToLines with recede dims everything except the last 2 items", () => {
  const lines = itemsToLines(items, 80, false, true);
  // Prompts render in heading ink (color.text): the settled one recedes to dim,
  // the live tail's stays bright.
  const prompts = textColors(lines, "prompt"); // [old prompt, new prompt]
  expect(prompts[0]).toBe(color.dim);
  expect(prompts[1]).toBe(color.text);
  const replies = textColors(lines, "reply"); // [old reply, streaming reply]
  expect(replies[0]).toBe(color.dim);
  expect(replies[1]).toBe(color.text);
});

test("the cache never serves receded lines to a normal render (recede keys the cache)", () => {
  const receded = itemsToLines(items, 80, false, true);
  expect(textColors(receded, "prompt")[0]).toBe(color.dim);
  const normal = itemsToLines(items, 80, false, false);
  expect(textColors(normal, "prompt")[0]).toBe(color.text); // same item objects, bright again
  const recededAgain = itemsToLines(items, 80, false, true);
  expect(textColors(recededAgain, "prompt")[0]).toBe(color.dim);
});

test("recede keeps every line within width (the invariant is not weakened)", () => {
  const lines = itemsToLines(items, 40, false, true);
  for (const l of lines) {
    expect(l.reduce((n, s) => n + s.text.length, 0)).toBeLessThanOrEqual(40);
  }
});
