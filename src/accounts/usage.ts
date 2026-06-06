// Per-account accounting — the ACCOUNT pillar's data. Persists spend + token
// totals + the latest rate-limit snapshot PER ACCOUNT across sessions, so you can
// see what each key/subscription is costing and how close it is to its limit.
// Cost is the provider's REAL number when reported (claude CLI total_cost_usd),
// else an estimate the caller computes from token usage × list price. This is
// also the ledger a future credit-aware router will read.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const home = () => process.env.GEARBOX_HOME || join(homedir(), ".gearbox");
const file = () => join(home(), "usage.json");

export interface RateSnapshot {
  utilization: number; // 0..1
  resetsAt?: number; // epoch seconds
  type?: string; // e.g. "seven_day" / "five_hour"
  at: number; // when we recorded it
}

// Remaining-credit snapshot for API keys (only some providers expose it).
export interface BalanceSnapshot {
  remainingUSD?: number; // dollars left, if the provider reports it
  totalUSD?: number; // the credit ceiling, if known (for a bar)
  at: number;
}

export interface AccountUsage {
  accountId: string;
  spentUSD: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  estimated: boolean; // true if any spend was an estimate (not a provider-reported figure)
  firstAt: number;
  lastAt: number;
  monthKey?: string; // "YYYY-MM" of the current calendar month being accumulated
  monthSpentUSD?: number; // spend within monthKey (resets when the month rolls over)
  rate?: RateSnapshot; // legacy single window (read for back-compat, written into rates)
  rates?: RateSnapshot[]; // one snapshot per limit window (5-hour, 7-day, …)
  balance?: BalanceSnapshot; // remaining API credit, where the provider exposes it
}

interface UsageFile {
  version: 1;
  accounts: Record<string, AccountUsage>;
}

function load(): UsageFile {
  try {
    const f = JSON.parse(readFileSync(file(), "utf8"));
    if (f && f.accounts) return { version: 1, ...f };
  } catch {
    /* none yet */
  }
  return { version: 1, accounts: {} };
}

function save(f: UsageFile): void {
  try {
    mkdirSync(home(), { recursive: true });
    writeFileSync(file(), JSON.stringify(f, null, 2), { mode: 0o600 });
  } catch {
    /* best-effort, like session save */
  }
}

/** Add a turn's usage to an account's running total. `costUSD` should be the
 *  provider's real figure when available, else a caller-computed estimate. */
export function recordUsage(opts: {
  accountId: string;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  estimated: boolean;
}): void {
  const f = load();
  const now = Date.now();
  const u = f.accounts[opts.accountId] ?? { accountId: opts.accountId, spentUSD: 0, inputTokens: 0, outputTokens: 0, turns: 0, estimated: false, firstAt: now, lastAt: now };
  u.spentUSD += opts.costUSD;
  u.inputTokens += opts.inputTokens;
  u.outputTokens += opts.outputTokens;
  u.turns += 1;
  u.estimated = u.estimated || opts.estimated;
  u.lastAt = now;
  // Calendar-month spend, so a self-accounted "monthly" budget can estimate the
  // remaining balance providers don't expose. Resets when the month rolls over.
  const mk = monthKeyOf(now);
  if (u.monthKey !== mk) { u.monthKey = mk; u.monthSpentUSD = 0; }
  u.monthSpentUSD = (u.monthSpentUSD ?? 0) + opts.costUSD;
  f.accounts[opts.accountId] = u;
  save(f);
}

function monthKeyOf(now: number): string {
  return new Date(now).toISOString().slice(0, 7); // "YYYY-MM"
}

/** Spend in the budget period: cumulative for a prepaid "total" budget, or just
 *  the current calendar month for a "monthly" one. */
export function spentInPeriod(u: AccountUsage, period: "total" | "monthly", now: number): number {
  if (period === "total") return u.spentUSD;
  return u.monthKey === monthKeyOf(now) ? (u.monthSpentUSD ?? 0) : 0;
}

/** Record the latest rate-limit snapshots for an account (claude CLI emits one
 *  window per event — 5-hour, 7-day). Merges by type so each window persists. */
export function recordRateLimits(accountId: string, rates: Omit<RateSnapshot, "at">[]): void {
  if (!rates.length) return;
  const f = load();
  const u = f.accounts[accountId];
  if (!u) return;
  const now = Date.now();
  const byType = new Map<string, RateSnapshot>();
  for (const r of u.rates ?? (u.rate ? [u.rate] : [])) byType.set(r.type ?? "limit", r);
  for (const r of rates) byType.set(r.type ?? "limit", { ...r, at: now });
  u.rates = [...byType.values()];
  u.rate = u.rates[0]; // keep legacy field populated
  save(f);
}

/** Record a remaining-credit snapshot for an API-key account (providers that
 *  expose it — e.g. OpenRouter). */
export function recordBalance(accountId: string, balance: Omit<BalanceSnapshot, "at">): void {
  const f = load();
  const u = f.accounts[accountId];
  if (!u) return;
  u.balance = { ...balance, at: Date.now() };
  save(f);
}

export function loadUsage(): AccountUsage[] {
  return Object.values(load().accounts).sort((a, b) => b.spentUSD - a.spentUSD);
}

export function accountUsage(id: string): AccountUsage | undefined {
  return load().accounts[id];
}

export function totalSpent(): number {
  return loadUsage().reduce((s, u) => s + u.spentUSD, 0);
}

const usd = (n: number) => (n < 0.01 && n > 0 ? "<$0.01" : "$" + n.toFixed(2));
const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Render the per-account spend ledger for /cost. `sessionUSD` is this session's
 *  estimate (from the status bar) for context. */
// Provider limit-window names → plain English (e.g. "seven_day" → "7-day").
const PRETTY_LIMIT: Record<string, string> = { seven_day: "7-day", five_hour: "5-hour", one_hour: "1-hour" };
const prettyLimit = (t?: string) => (t ? (PRETTY_LIMIT[t] ?? t.replace(/_/g, " ")) : "limit");

// Eighth-block ramp for sub-cell precision in bars.
const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const;
export const BAR_FULL = "█";
export const BAR_TRACK = "░";

/** A proportional bar split into a full run, an optional partial glyph, and the
 *  empty track — so a renderer can color the filled part and the track apart. */
export function barCells(frac: number, width: number): { fill: string; empty: string } {
  const units = Math.max(0, Math.min(1, frac || 0)) * width;
  const full = Math.floor(units);
  const partial = EIGHTHS[Math.round((units - full) * 8)] ?? "";
  const fill = BAR_FULL.repeat(full) + partial;
  const empty = BAR_TRACK.repeat(Math.max(0, width - full - (partial ? 1 : 0)));
  return { fill, empty };
}

// Structured /usage view. The meaningful metric differs by account type, so the
// view is split: SUBSCRIPTIONS (flat fee → what matters is rate-limit headroom,
// shown as a bar) and API KEYS (pay-per-token → what matters is dollars spent).
// Both renderers (inline + fullscreen) draw from this so they stay identical.
export interface LimitWindow {
  pct: number; // 0..100
  label: string; // "5-hour" / "7-day"
  resetsIn?: string; // "resets in 2h" (relative, if known)
}
export interface UsageAcct {
  name: string; // bare label (no "· subscription"/"· API key" suffix; the group says it)
  turns: number;
  tok: string; // "17.7k/34"
  spend?: string; // API keys: "$0.24 spent" (+ "~" if estimated)
  spendPos?: boolean; // spend > 0 (color it green vs faint)
  limits?: LimitWindow[]; // subscriptions: one per reported window (5-hour, 7-day)
  limitNote?: string; // subscriptions: why no provider-reported window is shown
  balanceLeft?: string; // API keys: "$12.40 left", where the provider exposes it
  balanceFrac?: number; // 0..1 remaining/total, for a bar (if total known)
  balanceNote?: string; // e.g. "balance not exposed" when we can't fetch it
}
export interface UsageView {
  subscriptions: UsageAcct[];
  apiKeys: UsageAcct[];
  labelPad: number; // shared name column width
  spendPad: number; // API-key spend column width
  totalApiSpend: string;
  sessionUSD?: string;
  hasEstimate: boolean;
}

export type AcctInfo = {
  name: string;
  kind: "sub" | "api";
  balanceExposed?: boolean; // provider can report remaining credit (e.g. OpenRouter)
  limitNote?: string;
};

// "resets in 2h" / "resets in 40m" from an epoch-seconds reset time.
function resetsIn(resetsAt?: number, now = Date.now()): string | undefined {
  if (!resetsAt) return undefined;
  const ms = resetsAt * 1000 - now;
  if (ms <= 0) return "resets now";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return h >= 1 ? `resets in ${h}h${m ? ` ${m}m` : ""}` : `resets in ${m}m`;
}

function observedAgo(at: number | undefined, now = Date.now()): string | undefined {
  if (!at) return undefined;
  const ms = Math.max(0, now - at);
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  if (h >= 1) return `observed ${h}h${m % 60 ? ` ${m % 60}m` : ""} ago`;
  return m <= 0 ? "observed just now" : `observed ${m}m ago`;
}

export function buildUsageView(sessionUSD?: number, resolve?: (id: string) => AcctInfo, now = Date.now(), accountIds: string[] = []): UsageView {
  const byId = new Map(loadUsage().map((u) => [u.accountId, u]));
  const ids = [...new Set([...accountIds, ...byId.keys()])];
  const info = (id: string): AcctInfo => (resolve ? resolve(id) : { name: id, kind: "api" });
  const subscriptions: UsageAcct[] = [];
  const apiKeys: UsageAcct[] = [];
  let apiTotal = 0;
  let estimated = false;

  for (const id of ids) {
    const u = byId.get(id) ?? { accountId: id, spentUSD: 0, inputTokens: 0, outputTokens: 0, turns: 0, estimated: false, firstAt: now, lastAt: now };
    const { name, kind, balanceExposed, limitNote } = info(u.accountId);
    const tok = `${fmtTok(u.inputTokens)}/${fmtTok(u.outputTokens)}`;
    if (u.estimated) estimated = true;
    if (kind === "sub") {
      const snaps = u.rates ?? (u.rate ? [u.rate] : []);
      // Stable order: 5-hour before 7-day before anything else.
      const order = (t?: string) => (t === "five_hour" ? 0 : t === "seven_day" ? 1 : 2);
      const limits: LimitWindow[] = snaps
        .slice()
        .sort((a, b) => order(a.type) - order(b.type))
        .map((r) => {
          const meta = [resetsIn(r.resetsAt, now), observedAgo(r.at, now)].filter(Boolean).join(" · ");
          return { pct: Math.round(r.utilization * 100), label: prettyLimit(r.type), resetsIn: meta || undefined };
        });
      subscriptions.push({ name, turns: u.turns, tok, limits: limits.length ? limits : undefined, limitNote: limits.length ? undefined : limitNote ?? "limits not observed yet" });
    } else {
      apiTotal += u.spentUSD;
      const acct: UsageAcct = { name, turns: u.turns, tok, spend: usd(u.spentUSD) + (u.estimated ? "~" : "") + " spent", spendPos: u.spentUSD > 0 };
      if (u.balance?.remainingUSD != null) {
        acct.balanceLeft = usd(u.balance.remainingUSD) + " left";
        if (u.balance.totalUSD) acct.balanceFrac = Math.max(0, Math.min(1, u.balance.remainingUSD / u.balance.totalUSD));
      } else if (!balanceExposed) {
        acct.balanceNote = "balance not exposed";
      }
      apiKeys.push(acct);
    }
  }

  const names = [...subscriptions, ...apiKeys].map((a) => a.name);
  return {
    subscriptions,
    apiKeys,
    labelPad: names.length ? Math.max(...names.map((n) => n.length)) : 0,
    spendPad: apiKeys.length ? Math.max(...apiKeys.map((a) => (a.spend ?? "").length)) : 0,
    totalApiSpend: usd(apiTotal),
    sessionUSD: sessionUSD != null ? usd(sessionUSD) : undefined,
    hasEstimate: estimated,
  };
}
