import { test, expect } from "bun:test";
import { homeShow } from "../src/ui/components/Mascot.tsx";
import { FACES, PALETTES, ACCESSORIES, PERSONAS } from "../src/ui/ghost/engine.ts";

// SHOW_PERIOD = 40 ticks, SHOW_ON = 19 — keep in lockstep with Mascot.tsx.
const PERIOD = 40;
const ON = 19;

test("homeShow: calm first cycle, then a bit every cycle (chaining or resting)", () => {
  // The whole first period is plain — the app never lands mid-costume.
  for (let t = 0; t < PERIOD; t++) expect(homeShow(t)).toBeNull();
  // From cycle 1 on, every cycle OPENS with a bit.
  for (let c = 1; c <= 20; c++) expect(homeShow(c * PERIOD)).not.toBeNull();
});

test("bits chain costume-to-costume; only some cycles rest back to plain Boo", () => {
  let chains = 0;
  let rests = 0;
  for (let c = 1; c <= 100; c++) {
    const tail = homeShow(c * PERIOD + ON); // after the ON window
    if (tail) {
      chains++;
      // a chaining cycle holds ITS OWN bit to the period's end…
      expect(homeShow(c * PERIOD + PERIOD - 1)).toEqual(homeShow(c * PERIOD));
      // …and the next cycle starts a different-seeded bit immediately
      expect(homeShow((c + 1) * PERIOD)).not.toBeNull();
    } else {
      rests++;
      expect(homeShow(c * PERIOD + PERIOD - 1)).toBeNull(); // calm until the period turns
    }
  }
  expect(chains).toBeGreaterThan(40); // most cycles morph straight to the next look
  expect(rests).toBeGreaterThan(15); // but plain Boo still shows up regularly
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

// ── per-tab looks ─────────────────────────────────────────────────────────────
import { lookForTabName, lookToCfg, isGhostLook } from "../src/ui/components/Mascot.tsx";
import { TAB_NAMES } from "../src/ui/tabbar.ts";

test("every wardrobe tab name maps to a valid Boo look", () => {
  for (const n of TAB_NAMES) {
    const look = lookForTabName(n)!;
    expect(look).toBeTruthy();
    expect(isGhostLook(look)).toBe(true);
    expect(lookToCfg(look)).toBeDefined();
  }
  expect(lookForTabName("wizard")).toBe("persona:wizard");
  expect(lookForTabName("mint")).toBe("mint");
  expect(lookForTabName("ember")).toBe("palette:ember");
  expect(lookForTabName("crown")).toBe("accessory:crown");
  expect(lookForTabName("fix-auth")).toBeNull(); // non-wardrobe names keep the pref
});
