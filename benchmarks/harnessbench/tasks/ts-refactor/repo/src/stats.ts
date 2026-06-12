export function summary(xs: number[]): { mean: number; median: number } {
  if (xs.length === 0) return { mean: 0, median: 0 };
  let s = 0;
  for (const x of xs) s += x;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const med = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return { mean: s / xs.length, median: med };
}
