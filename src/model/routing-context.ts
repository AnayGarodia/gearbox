// ── ROUTING CONTEXT (PER-TURN ACCOUNT SNAPSHOT) ───────────────────────────────
// This module distills account and usage data into a flat, in-memory snapshot
// that the router scores on every turn. Building the snapshot is cheap (a single
// pass over accounts.json and usage.json) and is done exactly once per routing
// decision so the scorer sees a consistent view.
//
// What the snapshot carries per account:
//   - Metered credit remaining: either a live balance exposed by the provider
//     (e.g. DeepSeek, OpenRouter) or an estimated balance derived from a
//     user-declared budget minus tracked spend. Used by the scarcity term.
//   - Subscription rate-limit headroom: the minimum (1 - utilization) across all
//     observed binding windows (5-hour and weekly). Used by planBonus and
//     limitPenalty. A seat with no observed window is assumed fresh.
//   - Live API throughput headroom: parsed from response headers (RPM/TPM
//     windows). Tracked separately from subscription windows because these
//     refill in seconds rather than hours.
//
// The builder accepts optional injected accounts/usage so tests can supply
// fixtures and exercise the distillation logic without touching disk.
import type { Account, ExecMode } from "../accounts/types.ts";
import { listAccounts } from "../accounts/store.ts";
import { loadUsage, spentInPeriod, type AccountUsage, type RateSnapshot } from "../accounts/usage.ts";
import { loadBudgets, type BudgetConfig } from "./preferences.ts";

// Everything the router needs to score one account in a single flat struct.
// All dollar and headroom figures are optional: absent means "no signal",
// which the scorer treats as neutral (zero penalty, not a penalty for absence).
export interface AccountState {
  accountId: string;
  provider: string;
  exec: ExecMode;
  isSubscription: boolean; // true when exec === "cli" (flat-rate seat, ~0 marginal cost until its limit)

  // Metered API credit. Populated from a live balance snapshot when the provider
  // exposes one, or estimated as budget minus period spend when the user has
  // declared a budget. Both paths set balanceEstimated appropriately.
  // undefined means neither source is available; the scorer leaves scarcity at 0.
  balanceRemainingUSD?: number;
  balanceTotalUSD?: number;
  balanceAt?: number; // unix-ms timestamp of the balance snapshot, for staleness checks
  balanceEstimated?: boolean; // true means derived from budget minus spend, not a live API figure

  // Subscription rate-limit headroom = min(1 - utilization) over all observed
  // SUBSCRIPTION windows (5-hour, weekly). 1 = completely fresh, 0 = exhausted.
  // undefined when no window has been observed yet (treated as fresh by the scorer).
  rateHeadroom?: number;
  // Headroom of the WEEKLY (seven_day) window alone, kept separate from the
  // binding-min above so the router can gate the "prefer subscription until 90%
  // weekly usage" rule on the weekly window specifically (a near-full 5-hour
  // window is short-term and handled by rateHeadroom/cooldown, not this cap).
  // undefined when no weekly window has been observed (treated as fresh).
  weeklyHeadroom?: number;
  bindingWindow?: { type?: string; utilization: number; resetsAt?: number }; // the tightest window
  rateAt?: number; // unix-ms timestamp of the rate snapshot

  // Live API throughput headroom = min(1 - utilization) over `api:*` windows
  // parsed from response headers (RPM/TPM). These windows refill in seconds to
  // minutes, so the scorer applies only a gentle penalty and only when the
  // window is nearly empty. undefined when no header-derived window is known.
  apiThrottle?: number;
}

// The per-turn snapshot handed to the router. `now` is injected so the scorer
// can check snapshot freshness without calling Date.now() itself (deterministic).
export interface RoutingContext {
  now: number; // injected wall-clock milliseconds
  byAccountId: Map<string, AccountState>; // one entry per enabled account
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

// Distill the rate snapshots for one account into headroom figures. Separates
// subscription windows (rateHeadroom, used for planBonus) from API throughput
// windows (apiThrottle, used for apiThrottlePenalty).
function headroomOf(u: AccountUsage | undefined, now: number): Pick<AccountState, "rateHeadroom" | "weeklyHeadroom" | "bindingWindow" | "rateAt" | "apiThrottle"> {
  const snaps: RateSnapshot[] = u?.rates ?? (u?.rate ? [u.rate] : []);
  let rateHeadroom: number | undefined;
  let weeklyHeadroom: number | undefined;
  let bindingWindow: AccountState["bindingWindow"];
  let apiThrottle: number | undefined;
  for (const r of snaps) {
    // Skip windows that have already reset. resetsAt is in epoch seconds; a
    // 5-hour or weekly window that expired in the past must not keep penalizing
    // a seat whose limit has since refreshed.
    if (typeof r.resetsAt === "number" && r.resetsAt * 1000 < now) continue;
    // Derive utilization from either the numeric field or the status word.
    // "rejected" = window full (utilization 1.0), "allowed_warning"/"warning"
    // = nearly full (0.9), anything else = assume empty (0).
    const util = typeof r.utilization === "number"
      ? r.utilization
      : r.status === "rejected" ? 1
      : r.status === "allowed_warning" || r.status === "warning" ? 0.9
      : 0;
    const h = 1 - clamp01(util);
    if (r.type?.startsWith("api:")) {
      // Short-term throughput windows from response headers, tracked separately
      // from subscription quota windows. Keep the tightest (minimum headroom).
      if (apiThrottle === undefined || h < apiThrottle) apiThrottle = h;
      continue;
    }
    // The weekly window drives the subscription-first cap (90% weekly usage),
    // so track it on its own in addition to folding it into the binding min.
    if (r.type === "seven_day" && (weeklyHeadroom === undefined || h < weeklyHeadroom)) weeklyHeadroom = h;
    // Subscription quota window: keep the tightest as the binding constraint.
    if (rateHeadroom === undefined || h < rateHeadroom) {
      rateHeadroom = h;
      bindingWindow = { type: r.type, utilization: util, resetsAt: r.resetsAt };
    }
  }
  return { rateHeadroom, weeklyHeadroom, bindingWindow, rateAt: snaps[0]?.at, apiThrottle };
}

// Build the per-turn routing snapshot. Reads accounts and usage from disk by
// default; pass opts to inject fixtures for testing.
export function buildRoutingContext(
  now: number,
  opts?: { accounts?: Account[]; usage?: AccountUsage[]; budgets?: Record<string, BudgetConfig> },
): RoutingContext {
  const accounts = opts?.accounts ?? listAccounts();
  const usageById = new Map((opts?.usage ?? loadUsage()).map((u) => [u.accountId, u]));
  const budgets = opts?.budgets ?? loadBudgets();
  const byAccountId = new Map<string, AccountState>();

  // One pass: build an AccountState for every enabled account. Disabled accounts
  // are skipped entirely so they do not appear in the scoring pool.
  for (const acct of accounts) {
    if (!acct.enabled) continue;
    const u = usageById.get(acct.id);
    byAccountId.set(acct.id, {
      accountId: acct.id,
      provider: acct.provider,
      exec: acct.exec,
      isSubscription: acct.exec === "cli",
      ...balanceOf(acct, u, budgets, now),
      ...headroomOf(u, now),
    });
  }

  // Budget-only providers: a user may declare `/budget anthropic 20` without
  // an accounts.json entry (the common env-key path). The router enumerates
  // those candidates as `env:<provider>`, but without an explicit accounts.json
  // row nothing would put that key in the map, so the declared budget would
  // never feed the scarcity term. Synthesize a minimal AccountState here so
  // the budget is honoured even without a stored account record.
  const coveredProviders = new Set([...byAccountId.values()].map((s) => s.provider));
  for (const [key, budget] of Object.entries(budgets)) {
    if (byAccountId.has(key) || coveredProviders.has(key)) continue; // already covered
    const envId = `env:${key}`;
    if (byAccountId.has(envId)) continue;
    const u = usageById.get(envId);
    const spent = u ? spentInPeriod(u, budget.period, now) : 0;
    byAccountId.set(envId, {
      accountId: envId,
      provider: key,
      exec: "in-loop",
      isSubscription: false,
      balanceRemainingUSD: Math.max(0, budget.amountUSD - spent),
      balanceTotalUSD: budget.amountUSD,
      balanceAt: now, // derived from our own ledger, so always fresh
      balanceEstimated: true,
      ...headroomOf(u, now),
    });
  }
  return { now, byAccountId };
}

// Resolve the metered balance for one account. Priority order:
//   1. Live balance from the provider's API (most accurate).
//   2. Estimated balance from a user-declared budget minus period spend.
//   3. No balance (returns empty, scorer treats scarcity as 0).
// Subscription seats never carry a dollar balance (they have rate headroom instead).
function balanceOf(
  acct: Account,
  u: AccountUsage | undefined,
  budgets: Record<string, BudgetConfig>,
  now: number,
): Pick<AccountState, "balanceRemainingUSD" | "balanceTotalUSD" | "balanceAt" | "balanceEstimated"> {
  // Subscription seats use rate headroom, not dollar balance.
  if (acct.exec === "cli") return {};
  // Live balance from the provider wins.
  if (u?.balance?.remainingUSD !== undefined) {
    return { balanceRemainingUSD: u.balance.remainingUSD, balanceTotalUSD: u.balance.totalUSD, balanceAt: u.balance.at };
  }
  // Fall back to budget minus tracked spend. Look up by account id first,
  // then by provider (a single budget entry can cover all keys for a provider).
  const budget = budgets[acct.id] ?? budgets[acct.provider];
  if (!budget) return {};
  const spent = u ? spentInPeriod(u, budget.period, now) : 0;
  return {
    balanceRemainingUSD: Math.max(0, budget.amountUSD - spent),
    balanceTotalUSD: budget.amountUSD,
    balanceAt: now, // computed from our own ledger, so always considered fresh
    balanceEstimated: true,
  };
}
