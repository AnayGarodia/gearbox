// ONE severity ramp for every utilization bar (context %, subscription windows,
// API rate headroom): healthy → attention → broken at the same thresholds, so a
// glance reads any bar the same way on any surface. Amber (warn), never accent —
// the cyan accent means "interactive/now" and stays out of the health scale.
import { color } from "./theme.ts";

export const limitColor = (pct: number): string => (pct >= 85 ? color.err : pct >= 60 ? color.warn : color.ok);
