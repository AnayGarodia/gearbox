// /theme: the palette switches in place (same object identity, every importer
// untouched) and bumps an epoch so baked-color caches invalidate.
import { test, expect, afterEach } from "bun:test";
import { color, dark, light, setTheme, activeTheme, themeEpoch as epochAtImport } from "../src/ui/theme.ts";
import * as theme from "../src/ui/theme.ts";
import { shimmer, bloom } from "../src/ui/shimmer.ts";

afterEach(() => setTheme("dark")); // module state is shared across test files in one bun run

test("default palette is dark", () => {
  expect(activeTheme()).toBe("dark");
  expect(color.accent).toBe(dark.accent);
});

test("setTheme('light') mutates color in place and bumps the epoch", () => {
  const before = theme.themeEpoch;
  setTheme("light");
  expect(activeTheme()).toBe("light");
  expect(color.accent).toBe(light.accent);
  expect(color.text).toBe(light.text);
  expect(theme.themeEpoch).toBe(before + 1);
  setTheme("dark");
  expect(color.accent).toBe(dark.accent);
  expect(theme.themeEpoch).toBe(before + 2);
});

test("every Theme field has a light value distinct from pure passthrough mistakes", () => {
  // The interface forces completeness at compile time; at runtime, sanity-check
  // the inks deepened for white: text must be dark, backgrounds must be pale.
  expect(light.text < "#777777").toBe(true); // dark ink
  expect(light.codeBg > "#DDDDDD").toBe(true); // pale chip
  // navy's semantic is "ink on an accent chip" — it must STAY dark in light mode.
  expect(light.navy).toBe(dark.navy);
});

test("shimmer/bloom follow a theme switch (no stale import-time capture)", () => {
  setTheme("light");
  const litShimmer = shimmer("working", 0).map((c) => c.color);
  const litBloom = bloom(5).color;
  expect(litShimmer).toContain(light.accent);
  expect(litShimmer).not.toContain(dark.accent);
  expect([light.faint, light.dim, light.accentDim, light.accent]).toContain(litBloom);
});

test("epoch import is a live binding (lines.ts cache relies on this)", () => {
  const startEpoch = theme.themeEpoch;
  setTheme("light");
  expect(theme.themeEpoch).toBeGreaterThan(startEpoch);
  expect(typeof epochAtImport).toBe("number");
});
