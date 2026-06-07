// The per-turn ACCOUNT-STATE snapshot the router scores against. Distilled ONCE
// per turn from accounts.json + usage.json into a flat, in-memory struct: how
// much metered credit each key has left (where the provider exposes it), and how
// much subscription rate-limit headroom each seat has (the binding window across
// the 5-hour AND weekly limits). This is the "cost/credit engine cache" from
// DESIGN.md — read off disk-cached usage, never a network call on the hot path
// (rate/balance snapshots are refreshed asynchronously elsewhere). The builder
// takes injected accounts/usage so the distillation is a PURE, testable fold;
// the no-arg path reads the real store.
import type { Account, ExecMode } from "../accounts/types.ts";
import { listAccounts } from "../accounts/store.ts";
import { loadUsage, spentInPeriod, type AccountUsage, type RateSnapshot } from "../accounts/usage.ts";
import { loadBudgets, type BudgetConfig } from "./preferences.ts";

export interface AccountState {
  accountId: string;
  provider: string;
  exec: ExecMode;
  isSubscription: boolean; // exec === "cli": a flat-rate seat (~0 marginal until its limit)

  // Metered API headroom. A live figure where the provider exposes one
  // (DeepSeek/OpenRouter/Vercel); otherwise ESTIMATED from a self-declared budget
  // minus our tracked spend, so scarcity still works for the providers that
  // expose nothing. undefined only when there's neither a live balance nor a
  // budget — and then the scorer leaves scarcity at 0 (no penalty).
  balanceRemainingUSD?: number;
  balanceTotalUSD?: number;
  balanceAt?: number; // staleness of the balance snapshot
  balanceEstimated?: boolean; // true ⇒ derived from budget − spend, not a live API figure

  // Subscription rate-limit headroom = min over all observed SUBSCRIPTION windows
  // of (1 − utilization). 1 = fresh, 0 = exhausted. undefined when no window seen.
  rateHeadroom?: number;
  bindingWindow?: { type?: string; utilization: number; resetsAt?: number };
  rateAt?: number; // staleness of the rate snapshot

  // Live API throughput headroom = min over `api:*` windows parsed from response
  // headers (RPM/TPM). These refill in seconds–minutes, so the scorer treats them
  // gently — only a near-empty window deprioritizes a key. undefined when unknown.
  apiThrottle?: number;
}

export interface RoutingContext {
  now: number; // injected for determinism
  byAccountId: Map<string, AccountState>;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

function headroomOf(u: AccountUsage | undefined): Pick<AccountState, "rateHeadroom" | "bindingWindow" | "rateAt" | "apiThrottle"> {
  const snaps: RateSnapshot[] = u?.rates ?? (u?.rate ? [u.rate] : []);
  let rateHeadroom: number | undefined;
  let bindingWindow: AccountState["bindingWindow"];
  let apiThrottle: number | undefined;
  for (const r of snaps) {
    // Utilization is a number when the provider reports one; otherwise infer
    // headroom from its status word (rejected = empty, allowed = full).
    const util = typeof r.utilization === "number" ? r.utilization : r.status === "rejected" ? 1 : r.status === "allowed_warning" || r.status === "warning" ? 0.9 : 0;
    const h = 1 - clamp01(util);
    if (r.type?.startsWith("api:")) {
      // Short-term throughput windows from response headers — tracked separately.
      if (apiThrottle === undefined || h < apiThrottle) apiThrottle = h;
      continue;
    }
    if (rateHeadroom === undefined || h < rateHeadroom) {
      rateHeadroom = h;
      bindingWindow = { type: r.type, utilization: util, resetsAt: r.resetsAt };
    }
  }
  return { rateHeadroom, bindingWindow, rateAt: snaps[0]?.at, apiThrottle };
}

export function buildRoutingContext(
  now: number,
  opts?: { accounts?: Account[]; usage?: AccountUsage[]; budgets?: Record<string, BudgetConfig> },
): RoutingContext {
  const accounts = opts?.accounts ?? listAccounts();
  const usageById = new Map((opts?.usage ?? loadUsage()).map((u) => [u.accountId, u]));
  const budgets = opts?.budgets ?? loadBudgets();
  const byAccountId = new Map<string, AccountState>();

  for (const acct of accounts) {
    if (!acct.enabled) continue;
    const u = usageById.get(acct.id);
    byAccountId.set(acct.id, {
      accountId: acct.id,
      provider: acct.provider,
      exec: acct.exec,
      isSubscription: acct.exec === "cli",
      ...balanceOf(acct, u, budgets, now),
      ...headroomOf(u),
    });
  }
  return { now, byAccountId };
}

// Resolve an account's metered balance: a live snapshot wins; else, if the user
// declared a budget for this account/provider, estimate remaining = budget −
// spend-in-period (subscriptions never carry a $ balance).
function balanceOf(
  acct: Account,
  u: AccountUsage | undefined,
  budgets: Record<string, BudgetConfig>,
  now: number,
): Pick<AccountState, "balanceRemainingUSD" | "balanceTotalUSD" | "balanceAt" | "balanceEstimated"> {
  if (acct.exec === "cli") return {};
  if (u?.balance?.remainingUSD !== undefined) {
    return { balanceRemainingUSD: u.balance.remainingUSD, balanceTotalUSD: u.balance.totalUSD, balanceAt: u.balance.at };
  }
  const budget = budgets[acct.id] ?? budgets[acct.provider];
  if (!budget) return {};
  const spent = u ? spentInPeriod(u, budget.period, now) : 0;
  return {
    balanceRemainingUSD: Math.max(0, budget.amountUSD - spent),
    balanceTotalUSD: budget.amountUSD,
    balanceAt: now, // computed from our own ledger ⇒ always fresh
    balanceEstimated: true,
  };
}
