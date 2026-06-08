// Pure data for the Providers cold-open block and the Providers tab.
//
// One row per configured account: a status dot (health → colour), the label, and a
// RIGHT field that is honest about money — a real remaining balance ONLY for the
// providers whose API actually exposes one (openrouter / vercel-gateway / deepseek
// via balanceExposed()); everyone else shows session spend, or an explicit
// "balance n/a". A balance is NEVER fabricated. A broken/expired/invalid account
// carries the exact fix command from fixHint(). No I/O — fed real Accounts + usage.
import { color, glyph } from "./theme.ts";
import type { Account, HealthState } from "../accounts/types.ts";
import type { AccountUsage } from "../accounts/usage.ts";
import { balanceExposed } from "../accounts/balance.ts";
import { fixHint } from "../agent/failover.ts";

export interface ProviderRowData {
  id: string;
  label: string;
  dotColor: string;
  dotGlyph: string;
  right: string; // "$12.40 left" | "$0.03 spent" | "balance n/a" | ""
  broken: boolean; // needs attention (drives the amber/red dot + fix hint)
  fixCmd?: string; // present only when broken
}

// Maps health state to dot color: green = ready, amber = needs attention
// (expired/rate-limited), red = broken (invalid/no-credit/error), faint = unknown.
export function healthDotColor(state: HealthState | undefined): string {
  switch (state) {
    case "ok":
      return color.ok;
    case "expired":
    case "rate-limited":
      return color.warn;
    case "invalid":
    case "no-credit":
    case "real-error":
      return color.err;
    default:
      return color.faint; // unknown / undefined (never probed)
  }
}

// Filled dot for a known state, hollow for unprobed/unknown, so an unprobed
// account never appears confidently green or red.
export function healthDotGlyph(state: HealthState | undefined): string {
  return state && state !== "unknown" ? glyph.on : glyph.off;
}

function isBroken(state: HealthState | undefined): boolean {
  return (
    state === "invalid" ||
    state === "no-credit" ||
    state === "expired" ||
    state === "rate-limited" ||
    state === "real-error"
  );
}

const BALANCE_STALE_MS = 60 * 60 * 1000; // 1 hour: older cached balances fall back to spend

// Build the right-hand money field. A balance appears only for providers that
// expose one and have a fresh cached figure; otherwise show spend or "n/a".
function moneyRight(account: Account, usage: AccountUsage | undefined, now: number): string {
  const exposed = balanceExposed(account.provider);
  const bal = usage?.balance;
  // now === 0 is a test sentinel meaning "skip the freshness check"; production
  // always passes Date.now(), so stale cached balances fall back to spend.
  const fresh = bal?.remainingUSD != null && (now === 0 || bal.at == null || now - bal.at < BALANCE_STALE_MS);
  if (exposed && fresh && bal?.remainingUSD != null) return `$${bal.remainingUSD.toFixed(2)} left`;
  const spent = usage?.spentUSD ?? 0;
  if (spent > 0) return `$${spent.toFixed(2)} spent`;
  // "balance n/a" is shown only for providers that cannot expose a balance, so it
  // reads as a capability fact rather than a transient zero.
  return exposed ? "" : "balance n/a";
}

export function providerRow(account: Account, usage: AccountUsage | undefined, now: number = 0): ProviderRowData {
  const state = account.health?.state;
  const broken = isBroken(state);
  return {
    id: account.id,
    label: account.label,
    dotColor: healthDotColor(state),
    dotGlyph: healthDotGlyph(state),
    right: moneyRight(account, usage, now),
    broken,
    fixCmd: broken ? fixHint(account, state!) : undefined,
  };
}

export function buildProvidersView(
  accounts: Account[],
  getUsage: (id: string) => AccountUsage | undefined,
  now: number = 0,
): ProviderRowData[] {
  const rows = accounts.map((a) => providerRow(a, getUsage(a.id), now));
  // Healthy first, attention next, broken last, then alphabetical. Broken accounts
  // sink to the bottom where the fix hint is visible.
  const rank = (r: ProviderRowData) =>
    r.dotColor === color.ok ? 0 : r.dotColor === color.warn ? 1 : r.dotColor === color.err ? 2 : 3;
  return rows.slice().sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}
