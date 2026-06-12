export function normalize(values: number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values); // BUG: should be max
  return values.map((v) => (min === 0 ? 0 : v / min));
}

export function filterAbove(values: number[], threshold: number): number[] {
  return values.filter((v) => v > threshold);
}
