import { normalize, filterAbove } from "./transform.js";

export function runPipeline(raw: number[], threshold: number): number[] {
  // BUG: normalizes first, then filters — should be filter then normalize
  const normalized = normalize(raw);
  return filterAbove(normalized, threshold);
}
