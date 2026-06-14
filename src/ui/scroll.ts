// Eased, line-quantized scroll stepping. A terminal grid can't render half a
// line, so "smooth" scrolling means moving an INTEGER number of lines per frame:
// a fraction of the remaining distance (so a jump decelerates instead of
// snapping), but always at least one line toward the target so it can never
// stall short of it, and never overshooting. Pure + deterministic → tested.

/** The next scrollTop one animation frame closer to `target`. */
export function easeScrollStep(cur: number, target: number, factor = 0.3): number {
  const rem = target - cur;
  if (rem === 0) return cur;
  const eased = Math.round(rem * factor);
  const step = rem > 0 ? Math.max(1, eased) : Math.min(-1, eased);
  const next = cur + step;
  return rem > 0 ? Math.min(next, target) : Math.max(next, target); // no overshoot
}

/** True once the glide has reached the target (the loop can stop). */
export function scrollSettled(cur: number, target: number): boolean {
  return cur === target;
}
