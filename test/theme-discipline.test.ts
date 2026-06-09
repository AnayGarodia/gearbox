// The look lives in theme.ts — and ONLY there. This test makes the discipline
// structural: a raw hex color anywhere else in src/ui fails the build, so the
// palette can never silently fork (and /theme light keeps working everywhere).
import { test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const UI_DIR = join(import.meta.dir, "..", "src", "ui");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}

test("no raw hex colors outside theme.ts (use the palette)", () => {
  const offenders: string[] = [];
  for (const file of walk(UI_DIR)) {
    if (file.endsWith("theme.ts")) continue;
    if (file.includes("/ghost/") || file.endsWith("mascot-png.ts") || file.endsWith("mascot-sprite.ts")) continue; // the mascot's pixel art is its own palette
    const src = readFileSync(file, "utf8");
    for (const [i, line] of src.split("\n").entries()) {
      const code = line.split("//")[0]!; // ignore comments
      if (/["'`]#[0-9a-fA-F]{6}\b/.test(code)) offenders.push(`${file.slice(UI_DIR.length + 1)}:${i + 1}`);
    }
  }
  expect(offenders).toEqual([]);
});

test("severity ramp is imported, not re-derived", () => {
  // limitColor must come from severity.ts — a re-declared local copy is how the
  // thresholds drifted apart across three surfaces before.
  for (const file of walk(UI_DIR)) {
    if (file.endsWith("severity.ts")) continue;
    const src = readFileSync(file, "utf8");
    expect(src.includes("const limitColor =")).toBe(false);
  }
});
