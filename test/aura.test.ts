// Aura pure helpers: the provider glow's math (mixing, wave levels, the
// metered gap mask) — the animated component itself is exercised by render.
import { test, expect } from "bun:test";
import { hexMix, auraLevel, auraGap } from "../src/ui/components/Aura.tsx";

test("hexMix interpolates between endpoints", () => {
  expect(hexMix("#000000", "#ffffff", 0)).toBe("#000000");
  expect(hexMix("#000000", "#ffffff", 1)).toBe("#ffffff");
  expect(hexMix("#000000", "#ffffff", 0.5)).toBe("#808080");
});

test("auraLevel stays in (0,1] and varies across the row", () => {
  const levels = Array.from({ length: 80 }, (_, x) => auraLevel(x, 80, 0.3));
  for (const l of levels) {
    expect(l).toBeGreaterThan(0);
    expect(l).toBeLessThanOrEqual(1);
  }
  expect(new Set(levels.map((l) => l.toFixed(2))).size).toBeGreaterThan(3); // a gradient, not a flat bar
});

test("auraGap drifts with phase (the metered ticker moves)", () => {
  const at = (phase: number) => Array.from({ length: 30 }, (_, x) => auraGap(x, phase));
  expect(at(0)).not.toEqual(at(0.2)); // segments moved
  expect(at(0).filter(Boolean).length).toBeGreaterThan(0); // gaps exist
});
