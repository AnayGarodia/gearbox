import { parseToken } from "./token";
export type Session = { userId: string; exp: number };
export function getSession(raw: string | null, now: number): Session | null {
  if (!raw) return null;
  const token = parseToken(raw);
  if (!token) return null;
  if (token.exp * 1000 < now) return null; // BUG: exp is SECONDS, now is MS
  return { userId: token.sub, exp: token.exp };
}