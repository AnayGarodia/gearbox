// The working animation: a soft pulse of light glides through the word — like a
// charge running through a gearbox — and a small indicator dot breathes beside it.
// Continuous and low-contrast (an in-family teal ramp), so it reads as a calm glow,
// a quiet sign of life. Deliberately NOT a spinning glyph and NOT a hard sweep with
// a pause (a pause reads as "stuck"); the light never stops, but it never flashes.
//
// Pure: returns per-character {ch, color} so both the Ink Working strip and the
// flat-line transcript buffer render the same effect (no raw ANSI). `frame` is a
// monotonic counter (Date.now()/STEP) so the glow advances one cell a tick.
import { color } from "./theme.ts";

// Base (unlit) → bright core. A glance reads dark→teal→cyan as "lighting up".
const GLOW = [color.faint, color.dim, color.accentDim, color.accent];

export function shimmer(text: string, frame: number): { ch: string; color: string }[] {
  const chars = [...text];
  const L = chars.length || 1;
  const peak = ((frame % L) + L) % L; // bright core, wrapping around the word
  return chars.map((ch, i) => {
    // Circular distance to the core so the glow wraps at the ends (never jumps).
    const raw = Math.abs(i - peak);
    const dist = Math.min(raw, L - raw);
    const idx = GLOW.length - 1 - dist; // core = brightest, fades out with distance
    return { ch, color: idx >= 0 ? GLOW[idx]! : GLOW[0]! };
  });
}

// A single indicator dot that breathes through the same ramp — a gentle heartbeat
// beside the verb, in sync with the glow. Up the ramp and back down, no hard edges.
export function pulse(frame: number): string {
  const span = GLOW.length * 2 - 2; // 0..3..0 triangle wave
  const p = ((frame % span) + span) % span;
  const idx = p < GLOW.length ? p : span - p;
  return GLOW[idx]!;
}

// The monotonic frame for the animation — one step every ~130ms (calm cadence;
// the footer re-renders on a 120ms motion tick while busy).
export const shimmerFrame = () => Math.floor(Date.now() / 130);
