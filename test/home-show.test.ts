import { test, expect } from "bun:test";
import { homeShow, HOME_SHOWS } from "../src/ui/components/Mascot.tsx";

test("homeShow: calm first cycle, then a bit per cycle that always ends", () => {
  // The whole first period is plain — the app never lands mid-costume.
  for (let t = 0; t < 100; t++) expect(homeShow(t)).toBeNull();
  // Cycle 1 plays show 0 for the ON window, then goes calm again.
  expect(homeShow(100)).toEqual(HOME_SHOWS[0]!);
  expect(homeShow(118)).toEqual(HOME_SHOWS[0]!);
  expect(homeShow(119)).toBeNull();
  expect(homeShow(199)).toBeNull();
  // Cycle 2 plays the NEXT show; the rotation wraps around the list.
  expect(homeShow(200)).toEqual(HOME_SHOWS[1]!);
  expect(homeShow(100 * (HOME_SHOWS.length + 1))).toEqual(HOME_SHOWS[0]!);
});

test("homeShow is deterministic (same tick → same bit, no randomness)", () => {
  expect(homeShow(300)).toEqual(homeShow(300));
});
