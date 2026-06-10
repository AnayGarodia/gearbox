// Typed provider-error taxonomy + retry policy. One place that answers, for
// any shape the AI SDK or fetch layer throws: WHAT failed and IS IT WORTH
// RETRYING. The runner's pre-output retry loop (run.ts) consumes `retryable`
// and `retryAfterMs`; the App-level hop-loop keeps handling the non-retryable
// classes (auth/quota → park the account and route around it, overflow →
// compact, abort → silence).
//
// Note on overlap with src/model/cooldown.ts classifyFailure: that classifier
// answers a DIFFERENT question ("can a sibling account serve this turn?") and
// deliberately groups rate+quota+billing as one failover class, with 529 in
// it. This taxonomy follows HTTP semantics instead (529/5xx = server,
// retryable on the SAME account), so the two are kept separate rather than
// forcing one to mis-answer the other's question. The string patterns below
// are aligned with cooldown.ts's where the classes coincide.
export type ProviderErrorKind =
  | "auth" // 401/403, invalid/expired key — dead until the user fixes it
  | "rate" // 429 — wait (retry-after) or route around
  | "quota" // insufficient credit / billing — dead until money is added
  | "overflow" // prompt exceeds the context window — retrying can't help
  | "server" // 5xx/529 — the provider's problem; retry
  | "network" // connection-level failure; retry
  | "abort" // the user interrupted; never retry
  | "invalid" // 400-class request problem (our bug or the model's)
  | "other";

export interface ProviderErrorClass {
  kind: ProviderErrorKind;
  retryable: boolean;
  /** From a Retry-After header (seconds or HTTP-date), when the provider sent one. */
  retryAfterMs?: number;
}

// Pull a status code out of the common error shapes (AI SDK APICallError uses
// statusCode; raw fetch responses use status).
function statusOf(err: unknown): number | undefined {
  const e = err as any;
  const s = e?.statusCode ?? e?.status ?? e?.response?.status ?? e?.cause?.statusCode ?? e?.cause?.status;
  return typeof s === "number" ? s : undefined;
}

// Flatten every message-ish field into one lowercase haystack for the regexes.
function messageOf(err: unknown): string {
  const e = err as any;
  const parts = [e?.message, e?.error?.message, e?.responseBody, e?.code, e?.cause?.message, e?.cause?.code, typeof err === "string" ? err : ""];
  return parts.filter((p) => typeof p === "string").join(" ").toLowerCase();
}

/** Parse a Retry-After header value: integer seconds OR an HTTP-date. */
export function parseRetryAfter(value: string | undefined, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  if (!Number.isNaN(at)) return Math.max(0, at - now);
  return undefined;
}

function retryAfterOf(err: unknown, now?: number): number | undefined {
  const headers = (err as any)?.responseHeaders ?? (err as any)?.response?.headers;
  if (!headers || typeof headers !== "object") return undefined;
  // Header maps from the SDK are plain lowercase-keyed records.
  const raw = headers["retry-after"] ?? headers["Retry-After"];
  return parseRetryAfter(typeof raw === "string" ? raw : undefined, now);
}

// Pattern groups. Where these classes coincide with cooldown.ts classifyFailure
// the strings are kept aligned (auth/quota/rate); the groupings differ on
// purpose (see the header comment).
const AUTH_RE =
  /invalid[ _-]?(api[ _-]?key|x-api-key|key|credential|token)|invalid subscription key|api key (?:not valid|invalid|expired)|unauthorized|authentication[ _-]?(error|failed)|token (?:has )?expired|expired (?:key|token|credentials?)|not logged in|re-?authenticat|session (?:has )?(?:ended|expired)|permission[ _-]?denied|forbidden/;
const QUOTA_RE = /insufficient_quota|insufficient (?:balance|credits?)|out of credit|credit balance|billing|payment required|\b402\b/;
const RATE_RE = /\b429\b|rate.?limit|too many requests|throttl|resource.?exhausted|usage.?limit/;
const OVERFLOW_RE = /context[ _-]?length[ _-]?exceeded|prompt is too long|maximum context|context window|too many (?:total )?(?:input )?tokens|exceeds the (?:maximum|model'?s) context|input is too long/;
const SERVER_RE = /\b5\d\d\b|\b529\b|over(?:loaded|capacity)|internal server error|server[ _-]?error|bad gateway|service unavailable|upstream/;
const NETWORK_RE = /econnreset|etimedout|econnrefused|enotfound|epipe|socket hang up|network|fetch failed|timed? ?out|connection (?:reset|closed|error)|stream error|temporarily unavailable/;

/** Classify any thrown provider error into a kind + retry decision. Pure. */
export function classifyProviderError(err: unknown, now?: number): ProviderErrorClass {
  const e = err as any;
  const status = statusOf(err);
  const m = messageOf(err);

  // Abort first: a user interrupt must never be retried or mis-read as network.
  if (e?.name === "AbortError" || /\baborted?\b/.test(m)) return { kind: "abort", retryable: false };

  // Overflow before the status buckets: some providers wear 400, some 413.
  if (status === 413 || OVERFLOW_RE.test(m)) return { kind: "overflow", retryable: false };

  if (status === 401 || status === 403 || AUTH_RE.test(m)) return { kind: "auth", retryable: false };

  // Quota before rate: OpenAI's insufficient_quota is billing wearing a 429.
  if (QUOTA_RE.test(m)) return { kind: "quota", retryable: false };

  if (status === 429 || RATE_RE.test(m)) {
    return { kind: "rate", retryable: true, retryAfterMs: retryAfterOf(err, now) };
  }

  if ((typeof status === "number" && status >= 500 && status <= 599) || SERVER_RE.test(m)) {
    return { kind: "server", retryable: true, retryAfterMs: retryAfterOf(err, now) };
  }

  if (NETWORK_RE.test(m)) return { kind: "network", retryable: true };

  if (status === 400 || /invalid[ _-]?request|invalid[ _-]?argument|bad request|validation/.test(m)) {
    return { kind: "invalid", retryable: false };
  }

  return { kind: "other", retryable: false };
}

/** Backoff for the runner's pre-output retry: honor Retry-After when present,
 *  else exponential (2s, 4s) with ±10% jitter so parallel turns don't thunder. */
export function retryDelayMs(cls: ProviderErrorClass, attempt: number, rand: () => number = Math.random): number {
  const base = cls.retryAfterMs ?? 2000 * 2 ** attempt;
  const jitter = 1 + (rand() * 0.2 - 0.1);
  return Math.round(base * jitter);
}

/** Don't sit on a long Retry-After inside the turn — past this, return the
 *  structured failure so the hop-loop can route to another account instead. */
export const MAX_INLINE_RETRY_DELAY_MS = 30_000;
