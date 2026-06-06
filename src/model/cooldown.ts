// Reactive failover support: when a turn fails because an account is out of
// quota/credit/rate, we park that account for a short cooldown so the router
// skips it — both for the immediate same-turn retry and for the next few turns,
// until its window resets. In-memory on purpose (a cooldown is ephemeral, like
// the rate state it reflects); it never needs to survive a restart.

export type FailureKind = "exhausted" | "other";

// Classify an error message: does it mean "this account can't serve right now,
// try another" (exhausted — rate limit / quota / credit / overload / throttle),
// or a real problem we shouldn't paper over by switching accounts? Pure.
export function classifyFailure(message: string): FailureKind {
  const m = (message || "").toLowerCase();
  const exhausted =
    /\b429\b|\b529\b|\b402\b/.test(m) ||
    /rate.?limit|too many requests|insufficient_quota|quota|over(loaded|capacity)|throttl|resource.?exhausted|usage.?limit|billing|payment required|out of credit|credit balance/.test(m);
  return exhausted ? "exhausted" : "other";
}

export const DEFAULT_COOLDOWN_MS = 5 * 60_000;

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
