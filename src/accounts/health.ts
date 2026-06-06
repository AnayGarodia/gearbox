// src/accounts/health.ts
// Account health: classify a provider error into a known state (pure, tested),
// and probe/cache an account's current health. Drives the /account badges and
// the failover decision (src/agent/failover.ts). No background polling.
import type { Account } from "./types.ts";

// "real-error" is the sentinel for "not a credential problem" — the failover
// loop must NOT advance the pool on it (network blip, model bug, 500).
export type HealthState = "ok" | "expired" | "invalid" | "no-credit" | "rate-limited" | "unknown" | "real-error";

export interface AccountHealth {
  state: HealthState;
  checkedAt: number;
  detail?: string;
}

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
