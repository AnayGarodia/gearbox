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

/** True when the error means "this specific model isn't deployed on the account"
 *  (Azure/Foundry: deployment doesn't exist). Distinct from a credential failure —
 *  the account is fine, only that one model id is missing. */
export function isNotDeployedError(message: string): boolean {
  const m = (message || "").toLowerCase();
  return /deployment.*does not exist|the api deployment for this resource does not exist|resource.*does not exist|no such deployment|model.*not.*found.*deployment/.test(m);
}

function statusOf(err: any): number | undefined {
  const s = err?.statusCode ?? err?.status ?? err?.response?.status ?? err?.data?.error?.status;
  if (typeof s === "number") return s;
  // testAccount/errMessage failures carry the status only in TEXT ("HTTP 401",
  // "… (HTTP 429) from <url>") — without this, a non-JSON 401/429 body
  // classified as "real-error" and never reached the credential-failover path.
  const m = textOf(err).match(/\bhttp[ _]?(\d{3})\b/);
  return m ? Number(m[1]) : undefined;
}
function textOf(err: any): string {
  return String(err?.message ?? err?.error?.message ?? err?.responseBody ?? err?.error ?? err ?? "").toLowerCase();
}

/** True for Bedrock's "model not enabled on this account/region" failure —
 *  an HTTP 403 that is a MODEL-AVAILABILITY problem, not a credential one
 *  (the fix is the Bedrock console's Model access page, never a new key). */
export function isModelAccessDenied(err: unknown): boolean {
  const t = textOf(err);
  return /don'?t have access to the model|access denied.*model|model.*access denied/.test(t);
}

/** Map a provider error (HTTP/SDK/CLI) to a health state. Pure. */
export function classifyError(_provider: string, err: unknown): HealthState {
  const status = statusOf(err);
  const t = textOf(err);

  // A genuine RATE limit whose message happens to mention billing (Google's
  // free-tier 429 says "check your plan and billing details") must classify as
  // rate-limited BEFORE the billing check — "add credit" is the wrong fix for
  // an RPM throttle, and waiting is the right one.
  if (status === 429 && !/insufficient_quota/.test(t) && /exceeded your current quota|resource.?exhausted|requests per (?:minute|day)/.test(t)) return "rate-limited";
  // No-credit before generic rate-limit/invalid: billing messages sometimes
  // arrive on 429/403. DeepSeek's 402 is "Insufficient Balance", OpenRouter's
  // is "Insufficient credits" — neither says "billing".
  if (status === 402 || /credit balance|insufficient_quota|insufficient funds|insufficient (?:balance|credits?)|billing|payment|quota exceeded/.test(t)) return "no-credit";
  if (/not logged in|not signed in|re-?authenticate|token (?:has )?expired|expired|session expired|login required|refresh token/.test(t)) return "expired";
  if (status === 429 || /rate.?limit|too many requests|overloaded|capacity/.test(t)) return "rate-limited";
  // Bedrock's "you don't have access to the model" 403: valid credentials, the
  // model just isn't enabled — calling it "invalid key" sent users to replace
  // keys that were fine. real-error keeps it out of the credential-failover
  // class; the actionable hint lives in unavailableModelHint.
  if (isModelAccessDenied(err)) return "real-error";
  // "invalid subscription key" is Azure's classic 401 body ("Access denied due
  // to invalid subscription key or wrong API endpoint") — the key itself is bad.
  if (status === 401 || status === 403 || /invalid.*(api.?key|x-api-key|credential|token)|invalid subscription key|incorrect api key|unauthorized|authentication.?fail|permission denied/.test(t)) return "invalid";
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
