// Aura — the soft halo behind the composer (the Gemini-style glow): a STATIC
// background wash in the active provider's brand hue, brightest behind the
// input and fading radially outward. No glyphs, no particles, no animation —
// pure ambient color that answers "what am I running on?" at a glance.
// Ink color/backgroundColor props only — never raw ANSI.
import React from "react";
import { Text } from "ink";
import { color } from "../theme.ts";

// Mix two hex colors: t=0 → a, t=1 → b. Quantized callers keep the distinct
// color count per row tiny (Ink emits one SGR per color change).
export function hexMix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (sa: number, sb: number) => Math.round(sa + (sb - sa) * t);
  const r = ch((pa >> 16) & 255, (pb >> 16) & 255);
  const g = ch((pa >> 8) & 255, (pb >> 8) & 255);
  const bl = ch(pa & 255, pb & 255);
  return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, "0")}`;
}

const LEVELS = 4; // quantized halo steps (0 = unpainted terminal canvas)
const MAX_TINT = 0.2; // hue fraction at the halo's center — a wash, not a stripe

/** Radial falloff for the halo row: tint level 0..LEVELS for column x
 *  (gaussian, brightest at center, 0 at the edges). Pure (tested). */
export function auraLevel(x: number, width: number): number {
  const c = (width - 1) / 2;
  const d = (x - c) / Math.max(1, width * 0.32);
  return Math.round(LEVELS * Math.exp(-d * d));
}

function AuraImpl({ hue, width }: { hue: string | null; width: number; epoch?: number }) {
  if (!hue || width < 8) return <Text> </Text>; // keep the row (layout contract), just blank
  // One bg shade per level, fading from the theme's ink-dark toward the brand
  // hue — read at render time so /theme switches apply live. Level 0 paints
  // nothing (the terminal's own canvas), so the halo has no hard edge.
  const shades = Array.from({ length: LEVELS + 1 }, (_, i) =>
    i === 0 ? undefined : hexMix(color.navy, hue, (MAX_TINT * i) / LEVELS),
  );
  // Build runs of same-shade cells so the row stays a handful of Text spans.
  const spans: React.ReactNode[] = [];
  let runShade: string | undefined = "";
  let run = "";
  for (let x = 0; x < width; x++) {
    const shade = shades[auraLevel(x, width)];
    if (shade !== runShade && run) {
      spans.push(<Text key={x - run.length} backgroundColor={runShade}>{run}</Text>);
      run = "";
    }
    runShade = shade;
    run += " ";
  }
  if (run) spans.push(<Text key={width - run.length} backgroundColor={runShade}>{run}</Text>);
  return <Text>{spans}</Text>;
}

export const Aura = React.memo(AuraImpl);
