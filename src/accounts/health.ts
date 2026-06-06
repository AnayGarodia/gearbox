// src/accounts/health.ts
// Account health: classify a provider error into a known state (pure, tested),
// and probe/cache an account's current health. Drives the /account badges and
// the failover decision (src/agent/failover.ts). No background polling.
import type { Account, AccountHealth, HealthState } from "./types.ts";
import { putAccount, getAccount } from "./store.ts";
import { testAccount, cliAuthStatus } from "./onboard.ts";
export type { AccountHealth, HealthState } from "./types.ts";

// Credential-class states are the only ones that trigger failover.
export function isCredentialFailure(s: HealthState): boolean {
  return s === "expired" || s === "invalid" || s === "no-credit" || s === "rate-limited";
}

function statusOf(err: any): number | undefined {
  return err?.statusCode ?? err?.status ?? err?.response?.status ?? err?.data?.error?.status;
}
function textOf(err: any): string {
  return String(err?.message ?? err?.error?.message ?? err?.responseBody ?? err?.error ?? err ?? "").toLowerCase();
}

/** Map a provider error (HTTP/SDK/CLI) to a health state. Pure. */
export function classifyError(_provider: string, err: unknown): HealthState {
  const status = statusOf(err);
  const t = textOf(err);

  // no-credit before rate-limit/invalid: billing messages sometimes ride a 429/403.
  if (/credit balance|insufficient_quota|insufficient funds|billing|payment|quota exceeded/.test(t)) return "no-credit";
  if (/not logged in|not signed in|re-?authenticate|token (?:has )?expired|expired|session expired|login required|refresh token/.test(t)) return "expired";
  if (status === 429 || /rate.?limit|too many requests|overloaded|capacity/.test(t)) return "rate-limited";
  if (status === 401 || status === 403 || /invalid.*(api.?key|x-api-key|credential|token)|incorrect api key|unauthorized|authentication.?fail|permission denied/.test(t)) return "invalid";
  return "real-error";
}

export const HEALTH_TTL_MS = 5 * 60_000;
export const HEALTH_CHECK_TIMEOUT_MS = 8_000;

/** Resolve `p`, but if it doesn't settle within `ms`, resolve `fallback` instead.
 *  Never rejects (a rejection from `p` propagates as usual — callers handle it). */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(fallback); } }, ms);
    p.then(
      (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
      (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } },
    );
  });
}

export function isFresh(h: AccountHealth | undefined, now: number): boolean {
  return !!h && now - h.checkedAt < HEALTH_TTL_MS;
}

/** Persist a freshly observed state for an account (called on success/failure). */
export function recordHealth(account: Account, state: HealthState, detail?: string): void {
  const at = Date.now();
  const cur = getAccount(account.id) ?? account;
  putAccount({ ...cur, health: { state, checkedAt: at, detail } });
}

/** Live probe of an account's credential. Cheap, no model generation.
 *  Reuses testAccount's connectivity checks; maps the result to a state.
 *  Always resolves within HEALTH_CHECK_TIMEOUT_MS — a hung endpoint never blocks callers. */
export function checkHealth(account: Account): Promise<AccountHealth> {
  const at = Date.now();
  const probe = (async (): Promise<AccountHealth> => {
    try {
      if (account.exec === "cli") {
        const bin = (account.auth as any).binary as string;
        const profile = (account.auth as any).loginProfile as string | undefined;
        const st = await cliAuthStatus(bin, profile);
        return { state: st.loggedIn ? "ok" : "expired", checkedAt: at, detail: st.detail };
      }
      const r = await testAccount(account);
      if (r.ok) return { state: "ok", checkedAt: at };
      return { state: classifyError(account.provider, { message: r.message }), checkedAt: at, detail: r.message };
    } catch (e) {
      return { state: classifyError(account.provider, e), checkedAt: at, detail: String((e as any)?.message ?? e) };
    }
  })();
  return withTimeout(probe, HEALTH_CHECK_TIMEOUT_MS, { state: "unknown", checkedAt: at, detail: "health check timed out" });
}
