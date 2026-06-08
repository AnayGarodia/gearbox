import { test, expect } from "bun:test";
import { shimmer, bloom } from "../src/ui/shimmer.ts";
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

test("bloom opens its petals from a point to a full burst and back, brightening as it opens", () => {
  // 6 petals → span 10, triangle 0,1,2,3,4,5,4,3,2,1.
  const closed = bloom(0);
  expect(closed.glyph).toBe("✦"); // smallest
  expect(closed.color).toBe(color.faint); // dimmest when closed
  const full = bloom(5);
  expect(full.glyph).toBe("✺"); // full sixteen-point bloom
  expect(full.color).toBe(color.accent); // brightest at full bloom
  expect(bloom(10).glyph).toBe("✦"); // cycle repeats — back to closed
  expect(bloom(7).glyph).toBe(bloom(3).glyph); // symmetric open/close (i=3 both)
});
