import { test, expect } from "bun:test";
import { shimmer, pulse } from "../src/ui/shimmer.ts";
import { color } from "../src/ui/theme.ts";

test("shimmer returns one segment per character with the text intact", () => {
  const segs = shimmer("Working", 0);
  expect(segs.map((s) => s.ch).join("")).toBe("Working");
});

test("the bright core sits at the sweeping peak and fades with distance", () => {
  // L=7, peak = frame % 7. At frame 0 the core is char 0 (brightest = accent).
  const at0 = shimmer("Working", 0);
  expect(at0[0]!.color).toBe(color.accent);
  expect(at0[1]!.color).toBe(color.accentDim); // one cell away fades
  // At frame 3 the core has glided to char 3.
  const at3 = shimmer("Working", 3);
  expect(at3.findIndex((s) => s.color === color.accent)).toBe(3);
});

test("the glow is continuous — there is always exactly one bright core, never an all-dark frame", () => {
  for (let f = 0; f < 14; f++) {
    const segs = shimmer("Working", f);
    expect(segs.filter((s) => s.color === color.accent).length).toBe(1); // always alive
  }
});

test("the glow wraps at the ends without jumping (circular distance)", () => {
  // L=7, peak at the last char (frame 6): char 0 is circular-distance 1 from it.
  const segs = shimmer("Working", 6);
  expect(segs[6]!.color).toBe(color.accent);
  expect(segs[0]!.color).toBe(color.accentDim); // wraps around, not faint
});

test("pulse breathes up the ramp and back down (a heartbeat, no hard edges)", () => {
  // span = 4*2-2 = 6 → triangle 0,1,2,3,2,1 repeating.
  expect(pulse(0)).toBe(color.faint);
  expect(pulse(3)).toBe(color.accent); // peak of the breath
  expect(pulse(6)).toBe(color.faint); // back to base, cycle repeats
});
