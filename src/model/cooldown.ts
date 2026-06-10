// Reactive failover support: when a turn fails because an account is out of
// quota/credit/rate, we park that account for a short cooldown so the router
// skips it — both for the immediate same-turn retry and for the next few turns,
// until its window resets. In-memory on purpose (a cooldown is ephemeral, like
// the rate state it reflects); it never needs to survive a restart.

export type FailureKind = "exhausted" | "auth" | "other";

// Classify an error message: does it mean "this account can't serve right now,
// try another"? Two failover-able classes — exhausted (rate limit / quota /
// credit / overload / throttle: the account recovers on its own) and auth
// (expired / invalid credentials: the account is dead until the user fixes it,
// but a SIBLING account can still serve the turn). Everything else is a real
// problem we shouldn't paper over by switching accounts. Pure.
export function classifyFailure(message: string): FailureKind {
  const m = (message || "").toLowerCase();
  const exhausted =
    /\b429\b|\b529\b|\b402\b/.test(m) ||
    /rate.?limit|too many requests|insufficient_quota|insufficient (?:balance|credits?)|quota|over(loaded|capacity)|throttl|resource.?exhausted|usage.?limit|billing|payment required|out of credit|credit balance/.test(m);
  if (exhausted) return "exhausted";
  const auth =
    /\b401\b/.test(m) ||
    // "invalid subscription key" = Azure's classic 401 body ("Access denied due
    // to invalid subscription key or wrong API endpoint") — a dead credential.
    /invalid[ _-]?(api[ _-]?key|x-api-key|key|credential|token)|invalid subscription key|api key (?:not valid|invalid|expired)|unauthorized|authentication[ _-]?(error|failed)|token (?:has )?expired|expired (?:key|token|credentials?)|not logged in|re-?authenticat|session (?:has )?(?:ended|expired)/.test(m);
  return auth ? "auth" : "other";
}

// How wide a cooldown should reach (R-5). A billing/credit failure drains the
// whole account's wallet, so every model on it is equally dead — park the
// account. A rate/overload/quota failure is usually scoped to one model or
// deployment (Anthropic/OpenAI limits are per model; Azure quota is per
// deployment), so parking the account would needlessly bench its siblings.
export type CooldownScope = "account" | "model";

export function cooldownScope(message: string): CooldownScope {
  const m = (message || "").toLowerCase();
  // Rate-ness first: Google's free-tier 429 says "check your plan and BILLING
  // details" — it's an RPM throttle on one model, not a drained wallet, and
  // parking the whole account for it benched every Gemini model for 5 minutes.
  // …except OpenAI's insufficient_quota, which is BILLING wearing a 429 and the
  // same "exceeded your current quota" sentence — that one drains the account.
  if (!/insufficient_quota/.test(m) && /\b429\b|rate.?limit|too many requests|exceeded your current quota|resource.?exhausted/.test(m)) return "model";
  const billing =
    /\b402\b/.test(m) ||
    /billing|payment required|out of credit|credit balance|insufficient_quota|insufficient (?:balance|credits?)/.test(m);
  return billing ? "account" : "model";
}

/** The composite key a model-scoped cooldown is stored under. One format,
 *  shared by the parker (App hop-loop) and the filter (router enumerate). */
export function modelScopedKey(accountKey: string, modelId: string): string {
  return `${accountKey}::${modelId}`;
}

export const DEFAULT_COOLDOWN_MS = 5 * 60_000;

// An auth-dead account (expired/invalid credentials) does not heal on its own
// the way a rate window does — 5 minutes later it is exactly as dead. Park it
// long enough that routing stops re-trying it every few turns; a successful
// /account login (or any recorded success) should clear it explicitly.
export const AUTH_COOLDOWN_MS = 24 * 60 * 60_000;

/** The park duration for a classified failure: auth gets the long park. */
export function cooldownMsFor(kind: FailureKind): number {
  return kind === "auth" ? AUTH_COOLDOWN_MS : DEFAULT_COOLDOWN_MS;
}

const cooldowns = new Map<string, { until: number; reason: string }>();

/** Park an account (or `env:<provider>` key) until `now + ms`. */
export function markExhausted(key: string, ms: number, reason: string, now: number = Date.now()): void {
  cooldowns.set(key, { until: now + Math.max(0, ms), reason });
}

export function coolingDown(key: string, now: number = Date.now()): boolean {
  const c = cooldowns.get(key);
  if (!c) return false;
  if (c.until <= now) { cooldowns.delete(key); return false; }
  return true;
}

export function cooldownReason(key: string, now: number = Date.now()): string | undefined {
  return coolingDown(key, now) ? cooldowns.get(key)!.reason : undefined;
}

/** Test/reset hook. */
export function clearCooldowns(): void {
  cooldowns.clear();
}
