// Aura — the ambient provider glow above the composer (the terminal take on
// Lovable/Gemini's gradient backdrops). One row of ▁ cells breathing in the
// ACTIVE provider's brand hue, so which backend you're on is visible at a
// glance without reading anything:
//   subscription seat → one continuous band (flat-rate: a steady glow)
//   API key           → the band runs as moving segments (a ticking meter:
//                       you're paying per token)
// Animation is deliberately calm (one slow drift tick, like Boo); set
// GEARBOX_NO_MOTION=1 to freeze. Ink color props only — never raw ANSI.
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

const LEVELS = 5; // quantized brightness steps per row

/** Per-cell brightness 0..1: two slow sine waves drifting with `phase`.
 *  Exported for tests (pure). */
export function auraLevel(x: number, width: number, phase: number): number {
  const u = x / Math.max(1, width);
  const w = 0.5 + 0.5 * Math.sin(2 * Math.PI * (u * 1.6 - phase));
  const v = 0.5 + 0.5 * Math.sin(2 * Math.PI * (u * 0.7 + phase * 0.6) + 1.7);
  return 0.25 + 0.75 * (0.6 * w + 0.4 * v);
}

/** Metered mask: every 6th cell (drifting with phase) goes dark, so an API-key
 *  aura reads as moving meter segments. Exported for tests (pure). */
export function auraGap(x: number, phase: number): boolean {
  return (x + Math.round(phase * 24)) % 6 === 0;
}

function AuraImpl({ hue, metered, width }: { hue: string | null; metered: boolean; width: number; epoch?: number }) {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    if (NO_MOTION || !hue) return;
    const t = setInterval(() => setPhase((p) => (p + 0.02) % 1), TICK_MS);
    return () => clearInterval(t);
  }, [hue]);
  if (!hue || width < 8) return <Text> </Text>; // keep the row (layout contract), just blank
  // Precompute the quantized shade ramp once per render.
  // The glow fades toward the theme's ink-dark (navy), read at render time so
  // /theme switches apply live.
  const shades = Array.from({ length: LEVELS + 1 }, (_, i) => hexMix(color.navy, hue, 0.12 + (0.55 * i) / LEVELS));
  // Build runs of same-shade cells so the row stays a handful of Text spans.
  const spans: React.ReactNode[] = [];
  let runShade = "";
  let run = "";
  for (let x = 0; x < width; x++) {
    const lvl = metered && auraGap(x, phase) ? 0 : Math.min(LEVELS, Math.round(auraLevel(x, width, phase) * LEVELS));
    const shade = shades[lvl]!;
    if (shade !== runShade && run) {
      spans.push(<Text key={x - run.length} color={runShade}>{run}</Text>);
      run = "";
    }
    runShade = shade;
    run += "▁";
  }
  if (run) spans.push(<Text key={width - run.length} color={runShade}>{run}</Text>);
  return <Text>{spans}</Text>;
}

export const Aura = React.memo(AuraImpl);
