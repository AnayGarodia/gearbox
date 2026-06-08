import { test, expect } from "bun:test";
import { shimmer } from "../src/ui/shimmer.ts";
import { color } from "../src/ui/theme.ts";

test("shimmer returns one segment per character with the text intact", () => {
  const segs = shimmer("Working", 0);
  expect(segs.map((s) => s.ch).join("")).toBe("Working");
});

test("the bright head sweeps left→right as the frame advances", () => {
  const firstBright = (f: number) => shimmer("Working", f).findIndex((s) => s.color === color.accent);
  expect(firstBright(0)).toBe(0);
  expect(firstBright(3)).toBe(2);
  expect(firstBright(4)).toBe(3); // the highlight travels right one cell per frame
});

test("between sweeps the whole word rests dim (a calm pause, no flicker)", () => {
  const segs = shimmer("Hi", 5); // len 2 + the 5-cell pause → head is past the word
  expect(segs.every((s) => s.color === color.dim)).toBe(true);
});
