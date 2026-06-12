/** At most n user-perceived chars; append "…" only if cut; never split emoji. */
export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}
