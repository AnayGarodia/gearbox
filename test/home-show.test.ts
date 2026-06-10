import { test, expect } from "bun:test";
import { homeShow } from "../src/ui/components/Mascot.tsx";
import { FACES, PALETTES, ACCESSORIES, PERSONAS } from "../src/ui/ghost/engine.ts";

// SHOW_PERIOD = 40 ticks, SHOW_ON = 19 — keep in lockstep with Mascot.tsx.
const PERIOD = 40;
const ON = 19;

test("homeShow: calm first cycle, then a bit per cycle that always ends", () => {
  // The whole first period is plain — the app never lands mid-costume.
  for (let t = 0; t < PERIOD; t++) expect(homeShow(t)).toBeNull();
  // Cycle 1 plays a bit for the ON window, then goes calm again.
  expect(homeShow(PERIOD)).not.toBeNull();
  expect(homeShow(PERIOD + ON - 1)).not.toBeNull();
  expect(homeShow(PERIOD + ON)).toBeNull();
  expect(homeShow(2 * PERIOD - 1)).toBeNull();
  expect(homeShow(2 * PERIOD)).not.toBeNull();
});

test("homeShow is deterministic (same tick → same bit, seeded PRNG not Math.random)", () => {
  for (const t of [PERIOD, PERIOD * 3, PERIOD * 7 + 5]) {
    expect(homeShow(t)).toEqual(homeShow(t));
  }
});

test("homeShow draws valid combos from the engine catalog only", () => {
  for (let cycle = 1; cycle <= 200; cycle++) {
    const show = homeShow(cycle * PERIOD)!;
    expect(show).not.toBeNull();
    expect(FACES[show.patch.face!]).toBeDefined();
    if (show.patch.palette) expect(PALETTES[show.patch.palette]).toBeDefined();
    if (show.patch.persona) expect(PERSONAS[show.patch.persona]).toBeDefined();
    if (show.patch.accessory) expect(ACCESSORIES[show.patch.accessory]).toBeDefined();
    // never both a persona and an accessory at once (one costume slot)
    expect(show.patch.persona && show.patch.accessory).toBeFalsy();
    if (show.patch.persona) {
      // persona bits play AS DESIGNED: the costume's own palette + face
      const per = PERSONAS[show.patch.persona]!;
      expect(show.patch.palette).toBe(per.palette);
      expect(show.patch.face).toBe(per.face);
    } else {
      // no downer faces on the welcome mat (a costume's designed face is exempt)
      expect(["sad", "angry", "crying", "thinking", "sleepy", "neutral"]).not.toContain(show.patch.face);
    }
  }
});

test("homeShow varies across cycles (it actually explores the catalog)", () => {
  const faces = new Set<string>();
  const palettes = new Set<string>();
  const costumes = new Set<string>();
  for (let cycle = 1; cycle <= 60; cycle++) {
    const show = homeShow(cycle * PERIOD)!;
    faces.add(show.patch.face!);
    if (show.patch.palette) palettes.add(show.patch.palette);
    if (show.patch.persona) costumes.add(show.patch.persona);
    if (show.patch.accessory) costumes.add(show.patch.accessory);
  }
  expect(faces.size).toBeGreaterThanOrEqual(5); // most of the 7 faces seen in 60 cycles
  expect(palettes.size).toBeGreaterThanOrEqual(5);
  expect(costumes.size).toBeGreaterThanOrEqual(8);
});

test("hearts always ride the love face", () => {
  for (let cycle = 1; cycle <= 200; cycle++) {
    const show = homeShow(cycle * PERIOD)!;
    if (show.patch.face === "love") expect(show.overlay).toBe("hearts");
  }
});
