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
import { loadUsage, type AccountUsage, type RateSnapshot } from "../accounts/usage.ts";

export interface AccountState {
  accountId: string;
  provider: string;
  exec: ExecMode;
  isSubscription: boolean; // exec === "cli": a flat-rate seat (~0 marginal until its limit)

  // Metered API headroom — undefined when the provider does not expose a balance
  // (the common case: Anthropic/OpenAI/Google/Bedrock/Vertex/Azure). Absence is
  // NOT scarcity; the scorer leaves the scarcity term at 0 when this is unset.
  balanceRemainingUSD?: number;
  balanceTotalUSD?: number;
  balanceAt?: number; // staleness of the balance snapshot

  // Subscription rate-limit headroom = min over all observed windows of
  // (1 − utilization). 1 = fresh, 0 = exhausted. undefined when no window seen.
  rateHeadroom?: number;
  bindingWindow?: { type?: string; utilization: number; resetsAt?: number };
  rateAt?: number; // staleness of the rate snapshot
}

export interface RoutingContext {
  now: number; // injected for determinism
  byAccountId: Map<string, AccountState>;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

function headroomOf(u: AccountUsage | undefined): Pick<AccountState, "rateHeadroom" | "bindingWindow" | "rateAt"> {
  const snaps: RateSnapshot[] = u?.rates ?? (u?.rate ? [u.rate] : []);
  let rateHeadroom: number | undefined;
  let bindingWindow: AccountState["bindingWindow"];
  for (const r of snaps) {
    const h = 1 - clamp01(r.utilization);
    if (rateHeadroom === undefined || h < rateHeadroom) {
      rateHeadroom = h;
      bindingWindow = { type: r.type, utilization: r.utilization, resetsAt: r.resetsAt };
    }
  }
  return { rateHeadroom, bindingWindow, rateAt: snaps[0]?.at };
}

export function buildRoutingContext(
  now: number,
  opts?: { accounts?: Account[]; usage?: AccountUsage[] },
): RoutingContext {
  const accounts = opts?.accounts ?? listAccounts();
  const usageById = new Map((opts?.usage ?? loadUsage()).map((u) => [u.accountId, u]));
  const byAccountId = new Map<string, AccountState>();

  for (const acct of accounts) {
    if (!acct.enabled) continue;
    const u = usageById.get(acct.id);
    byAccountId.set(acct.id, {
      accountId: acct.id,
      provider: acct.provider,
      exec: acct.exec,
      isSubscription: acct.exec === "cli",
      balanceRemainingUSD: u?.balance?.remainingUSD,
      balanceTotalUSD: u?.balance?.totalUSD,
      balanceAt: u?.balance?.at,
      ...headroomOf(u),
    });
  }
  return { now, byAccountId };
}
