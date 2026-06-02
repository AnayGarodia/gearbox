export type Token = { sub: string; exp: number }; // exp = epoch SECONDS
export function parseToken(raw: string): Token | null {
  const [sub, expStr] = raw.split(":");
  if (!sub || !expStr) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp)) return null;
  return { sub, exp };
}