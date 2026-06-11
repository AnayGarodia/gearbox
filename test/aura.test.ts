// Aura pure helpers: hex mixing and the particle field math — the animated
// component itself is exercised by render.
import { test, expect } from "bun:test";
import { hexMix, auraCell } from "../src/ui/components/Aura.tsx";

test("hexMix interpolates between endpoints", () => {
  expect(hexMix("#000000", "#ffffff", 0)).toBe("#000000");
  expect(hexMix("#000000", "#ffffff", 1)).toBe("#ffffff");
  expect(hexMix("#000000", "#ffffff", 0.5)).toBe("#808080");
});

test("the mote field is sparse, varied, and deterministic", () => {
  const row = Array.from({ length: 120 }, (_, x) => auraCell(x, 120, 0.3, false));
  const motes = row.filter((g) => g > 0);
  expect(motes.length).toBeGreaterThan(10); // a sky, not emptiness
  expect(motes.length).toBeLessThan(110); // sparse, not a bar
  expect(new Set(motes).size).toBeGreaterThan(1); // varied depths/sizes
  // deterministic: same inputs, same sky
  expect(row).toEqual(Array.from({ length: 120 }, (_, x) => auraCell(x, 120, 0.3, false)));
});

test("seat motes hold position while twinkling; metered motes drift", () => {
  const at = (phase: number, metered: boolean) => Array.from({ length: 80 }, (_, x) => auraCell(x, 80, phase, metered) > 0);
  // seat: occupied columns are phase-invariant (only brightness changes)
  expect(at(0.1, false)).toEqual(at(0.6, false));
  // metered: the field itself moves
  expect(at(0.1, true)).not.toEqual(at(0.6, true));
});
