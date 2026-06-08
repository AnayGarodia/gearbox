// The working animation: a single bright "current" sweeps left→right through the
// word, like a charge running down a gearbox — then a brief pause, then again.
// Calm and mechanical, a quiet sign of life. Deliberately NOT a spinning glyph and
// NOT a full-word brightness pulse — one travelling highlight over a dim word.
//
// Pure: returns per-character {ch, color} so both the Ink Working strip and the
// flat-line transcript buffer render the same effect (no raw ANSI). `frame` is a
// monotonic counter (e.g. Date.now()/90) so the highlight advances one cell a tick.
import { color } from "./theme.ts";

export function shimmer(text: string, frame: number): { ch: string; color: string }[] {
  const chars = [...text];
  const head = ((frame % (chars.length + 5)) + chars.length + 5) % (chars.length + 5); // sweep + a short pause
  return chars.map((ch, i) => {
    const d = head - i; // 0 = the bright head; small positive = the fading trail
    const c = d === 0 || d === 1 ? color.accent : d === 2 ? color.accentDim : color.dim;
    return { ch, color: c };
  });
}

// The monotonic frame for the shimmer — one step every ~90ms.
export const shimmerFrame = () => Math.floor(Date.now() / 90);
