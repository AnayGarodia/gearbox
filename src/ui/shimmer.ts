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

// A blooming flower beside the verb: an asterisk that opens its petals from a tiny
// point to a full sixteen-point burst and closes again, brightening as it opens and
// dimming as it closes — one breath of light. The petal count and the color move
// together, so it reads as a flower breathing, not a glyph cycling. Calm, on-brand
// (a sparkle, never a spinning glyph).
const PETALS = ["✦", "✶", "✷", "✸", "✹", "✺"]; // closed → full bloom
export function bloom(frame: number): { glyph: string; color: string } {
  const span = PETALS.length * 2 - 2; // open then close: 0,1,2,3,4,5,4,3,2,1
  const p = ((frame % span) + span) % span;
  const i = p < PETALS.length ? p : span - p;
  const openness = i / (PETALS.length - 1); // 0 (closed) → 1 (full)
  const c = GLOW[Math.round(openness * (GLOW.length - 1))]!;
  return { glyph: PETALS[i]!, color: c };
}

// The monotonic frame for the animation — one step every ~130ms (calm cadence;
// the footer re-renders on a 120ms motion tick while busy).
export const shimmerFrame = () => Math.floor(Date.now() / 130);
