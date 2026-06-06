// Creative workaround for "the API won't tell me my limits": it actually DOES,
// on every response, in rate-limit HEADERS — we just have to read them. Anthropic,
// OpenAI, and Azure (and most OpenAI-wire providers) return remaining/limit per
// window; this turns those into utilization snapshots the router can act on
// PROACTIVELY (deprioritize / fail over a near-empty key before it 429s) instead
// of only reacting to the error. Tagged `api:*` so the routing-context keeps them
// separate from subscription 5h/weekly windows — they are short-term throughput
// buckets (RPM/TPM that refill in seconds–minutes), so the scorer treats them
// gently (only bites when a window is genuinely near-empty). Pure + testable.

export interface RateLike {
  utilization: number; // 0..1
  resetsAt?: number; // epoch seconds
  type: string; // "api:requests" | "api:tokens"
}

// Parse a Go time.Duration string ("1s", "6m0s", "114h18m0s", "300ms") to seconds.
export function parseGoDuration(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    matched = true;
    const n = Number(m[1]);
    total += m[2] === "h" ? n * 3600 : m[2] === "m" ? n * 60 : m[2] === "ms" ? n / 1000 : n;
  }
  return matched ? total : undefined;
}

const num = (v: string | undefined): number | undefined => {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

// Resolve a reset value to epoch seconds: Anthropic sends an RFC3339 timestamp,
// OpenAI a Go-duration from now, Azure sometimes plain seconds.
function resetSeconds(raw: string | undefined, now: number): number | undefined {
  if (!raw) return undefined;
  const iso = Date.parse(raw);
  if (!Number.isNaN(iso)) return Math.floor(iso / 1000);
  const dur = parseGoDuration(raw);
  if (dur != null) return Math.floor(now / 1000) + Math.round(dur);
  const secs = num(raw);
  return secs != null ? Math.floor(now / 1000) + Math.round(secs) : undefined;
}

function window(limit: number | undefined, remaining: number | undefined, reset: string | undefined, type: string, now: number): RateLike | null {
  if (limit == null || limit <= 0 || remaining == null) return null; // can't compute utilization
  return { utilization: clamp01(1 - remaining / limit), resetsAt: resetSeconds(reset, now), type };
}

/** Extract `api:*` rate-limit windows from a provider's response headers. Header
 *  names are matched case-insensitively. Returns [] when nothing is parseable —
 *  never throws (a provider that exposes no usable headers just yields no signal). */
export function parseRateHeaders(_provider: string, headers: Record<string, string | undefined>, now: number): RateLike[] {
  const h: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
  const out: RateLike[] = [];

  // Anthropic style.
  const aReq = window(num(h["anthropic-ratelimit-requests-limit"]), num(h["anthropic-ratelimit-requests-remaining"]), h["anthropic-ratelimit-requests-reset"], "api:requests", now);
  const aTok = window(num(h["anthropic-ratelimit-tokens-limit"]), num(h["anthropic-ratelimit-tokens-remaining"]), h["anthropic-ratelimit-tokens-reset"], "api:tokens", now);
  if (aReq) out.push(aReq);
  if (aTok) out.push(aTok);

  // OpenAI / Azure / OpenAI-wire style.
  const oReq = window(num(h["x-ratelimit-limit-requests"]), num(h["x-ratelimit-remaining-requests"]), h["x-ratelimit-reset-requests"], "api:requests", now);
  const oTok = window(num(h["x-ratelimit-limit-tokens"]), num(h["x-ratelimit-remaining-tokens"]), h["x-ratelimit-reset-tokens"], "api:tokens", now);
  if (oReq && !aReq) out.push(oReq);
  if (oTok && !aTok) out.push(oTok);

  return out;
}
