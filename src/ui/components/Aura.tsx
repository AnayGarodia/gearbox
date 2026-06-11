// Aura — the ambient provider shimmer above the composer: sparse glowing motes
// in the ACTIVE provider's brand hue (the terminal take on Lovable/Gemini's
// gradient backdrops — depth from particle size + brightness, never a bar).
// The backend kind is the MOTION:
//   subscription seat → motes twinkle in place (flat-rate: a steady glow)
//   API key           → motes stream sideways (metered: tokens flowing out)
// Deliberately calm (one slow tick, like Boo); GEARBOX_NO_MOTION=1 freezes.
// Ink color props only — never raw ANSI.
import React, { useEffect, useState } from "react";
import { Text } from "ink";
import { color } from "../theme.ts";

const NO_MOTION = !!process.env.GEARBOX_NO_MOTION;
const TICK_MS = 280; // slow drift — ambience, not fidgeting

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

// Deterministic per-column hash (0..1) — particles must be stable across
// renders (Math.random would re-roll the sky every frame).
function hash(x: number, salt: number): number {
  const s = Math.sin(x * 127.1 + salt * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

const DENSITY = 0.4; // fraction of columns carrying a mote
// Mote glyphs by brightness: faint dust → bright spark. All width-1.
const GLYPHS = [" ", "˙", "·", "•", "✦"] as const;

/** One cell of the shimmer field. Pure (tested): returns the glyph index
 *  0..4 (0 = empty sky) for column x at animation phase 0..1. `metered`
 *  streams the field sideways; otherwise motes twinkle in place. */
export function auraCell(x: number, width: number, phase: number, metered: boolean): number {
  // Metered: the whole field drifts left over time (sample a moving window).
  const fx = metered ? (x + Math.round(phase * 96)) % Math.max(width, 1) : x;
  if (hash(fx, 1) > DENSITY) return 0; // no mote in this column
  const depth = hash(fx, 2); // 0..1 — how "close" the mote is (size + brightness)
  // Twinkle: each mote breathes on its own offset so the sky never pulses in unison.
  const tw = 0.55 + 0.45 * Math.sin(2 * Math.PI * (phase * 2 + hash(fx, 3)));
  const b = depth * tw;
  return b < 0.12 ? 1 : b < 0.32 ? 2 : b < 0.62 ? 3 : 4;
}

function AuraImpl({ hue, metered, width }: { hue: string | null; metered: boolean; width: number; epoch?: number }) {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    if (NO_MOTION || !hue) return;
    const t = setInterval(() => setPhase((p) => (p + 0.01) % 1), TICK_MS);
    return () => clearInterval(t);
  }, [hue]);
  if (!hue || width < 8) return <Text> </Text>; // keep the row (layout contract), just blank
  // One shade per glyph tier, fading from the theme's ink-dark toward the brand
  // hue — read at render time so /theme switches apply live.
  const shades = GLYPHS.map((_, i) => hexMix(color.navy, hue, 0.18 + 0.62 * (i / (GLYPHS.length - 1))));
  // Build runs of same-shade cells so the row stays a handful of Text spans.
  const spans: React.ReactNode[] = [];
  let runShade = "";
  let run = "";
  for (let x = 0; x < width; x++) {
    const g = auraCell(x, width, phase, metered);
    const shade = shades[g]!;
    if (shade !== runShade && run) {
      spans.push(<Text key={x - run.length} color={runShade}>{run}</Text>);
      run = "";
    }
    runShade = shade;
    run += GLYPHS[g];
  }
  if (run) spans.push(<Text key={width - run.length} color={runShade}>{run}</Text>);
  return <Text>{spans}</Text>;
}

export const Aura = React.memo(AuraImpl);
