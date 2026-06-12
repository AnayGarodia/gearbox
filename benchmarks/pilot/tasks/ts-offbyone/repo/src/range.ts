/** Inclusive integer range: range(2, 5) => [2, 3, 4, 5]. */
export function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}
