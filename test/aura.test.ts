// Aura pure helpers: hex mixing and the halo falloff — the component itself is
// exercised by render.
import { test, expect } from "bun:test";
import { hexMix, auraLevel } from "../src/ui/components/Aura.tsx";

test("hexMix interpolates between endpoints", () => {
  expect(hexMix("#000000", "#ffffff", 0)).toBe("#000000");
  expect(hexMix("#000000", "#ffffff", 1)).toBe("#ffffff");
  expect(hexMix("#000000", "#ffffff", 0.5)).toBe("#808080");
});

test("the halo is brightest at center and unpainted at the edges", () => {
  const w = 100;
  const center = auraLevel(Math.floor(w / 2), w);
  expect(center).toBeGreaterThan(auraLevel(Math.floor(w / 4), w)); // falls off
  expect(auraLevel(0, w)).toBe(0); // edges: terminal canvas, no hard stripe
  expect(auraLevel(w - 1, w)).toBe(0);
  // symmetric-ish
  expect(auraLevel(20, w)).toBe(auraLevel(w - 1 - 20, w));
});
