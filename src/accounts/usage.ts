// Per-account accounting — the ACCOUNT pillar's data. Persists spend + token
// totals + the latest rate-limit snapshot PER ACCOUNT across sessions, so you can
// see what each key/subscription is costing and how close it is to its limit.
// Cost is the provider's REAL number when reported (claude CLI total_cost_usd),
// else an estimate the caller computes from token usage × list price. This is
// also the ledger a future credit-aware router will read.
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { budgetFor } from "../model/preferences.ts";

const home = () => process.env.GEARBOX_HOME || join(homedir(), ".gearbox");
const file = () => join(home(), "usage.json");

export interface RateSnapshot {
  utilization?: number; // 0..1; absent when the provider reports only a status word
  status?: string; // provider's own state, e.g. "allowed" / "allowed_warning" / "rejected"
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
  dayKey?: string; // "YYYY-MM-DD" of the current day being accumulated
  daySpentUSD?: number; // spend within dayKey (resets when the day rolls over)
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
    // A torn/corrupt ledger is preserved (not silently discarded) so the spend
    // history can be recovered by hand; the app continues on a fresh file.
    try {
      if (existsSync(file())) renameSync(file(), `${file()}.corrupt`);
    } catch { /* best-effort */ }
  }
  return { version: 1, accounts: {} };
}

function save(f: UsageFile): void {
  try {
    mkdirSync(home(), { recursive: true });
    // Temp-write + rename: the rename is atomic (same directory), so a crash
    // mid-write can never tear usage.json and reset the whole spend history.
    const tmp = `${file()}.tmp`;
    writeFileSync(tmp, JSON.stringify(f, null, 2), { mode: 0o600 });
    renameSync(tmp, file());
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
  // Per-day spend, so a hard "daily" cap (budget-guard.ts) can enforce. Resets on day rollover.
  const dk = dayKeyOf(now);
  if (u.dayKey !== dk) { u.dayKey = dk; u.daySpentUSD = 0; }
  u.daySpentUSD = (u.daySpentUSD ?? 0) + opts.costUSD;
  f.accounts[opts.accountId] = u;
  save(f);
}

function monthKeyOf(now: number): string {
  return new Date(now).toISOString().slice(0, 7); // "YYYY-MM"
}

function dayKeyOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10); // "YYYY-MM-DD"
}

/** Spend recorded for the calendar day of `now` for this account (0 after rollover). */
export function spentToday(u: AccountUsage, now: number): number {
  return u.dayKey === dayKeyOf(now) ? (u.daySpentUSD ?? 0) : 0;
}

/** Total spend across all accounts for the calendar day of `now`. */
export function totalSpentToday(now = Date.now()): number {
  return loadUsage().reduce((s, u) => s + spentToday(u, now), 0);
}

/** Total spend across all accounts for the calendar month of `now`. */
export function totalSpentThisMonth(now = Date.now()): number {
  return loadUsage().reduce((s, u) => s + spentInPeriod(u, "monthly", now), 0);
}

/** Spend in the budget period: cumulative for a prepaid "total" budget, or just
 *  the current calendar month for a "monthly" one. */
export function spentInPeriod(u: AccountUsage, period: "total" | "monthly", now: number): number {
  if (period === "total") return u.spentUSD;
  return u.monthKey === monthKeyOf(now) ? (u.monthSpentUSD ?? 0) : 0;
}

/** Record the latest rate-limit snapshots for an account (claude CLI emits one
 *  window per event — 5-hour, 7-day). Merges by type so each window persists.
 *  A snapshot may carry its own `at` (real observation time) — used when the data
 *  is read from a possibly-stale source (e.g. a Codex rollout) so staleness reads
 *  honestly; otherwise it's stamped now. */
export function recordRateLimits(
  accountId: string,
  rates: (Omit<RateSnapshot, "at"> & { at?: number })[],
  opts: { replace?: boolean } = {},
): void {
  if (!rates.length) return;
  const f = load();
  const u = f.accounts[accountId];
  if (!u) return;
  const now = Date.now();
  const byType = new Map<string, RateSnapshot>();
  // replace = this is a COMPLETE snapshot (the usage probe), so it's authoritative
  // about which windows exist — start empty so stale windows the source no longer
  // reports (e.g. a 7-day that a Pro plan dropped) are removed, not kept forever.
  if (!opts.replace) for (const r of u.rates ?? (u.rate ? [u.rate] : [])) byType.set(r.type ?? "limit", r);
  for (const r of rates) byType.set(r.type ?? "limit", { ...r, at: r.at ?? now });
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
// api:* windows are the per-minute API rate-limit headroom from response headers.
const PRETTY_LIMIT: Record<string, string> = {
  seven_day: "7-day", five_hour: "5-hour", one_hour: "1-hour",
  "api:requests": "req/min", "api:tokens": "tok/min",
};
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
  pct?: number; // 0..100 utilization; absent when the provider reports only a status
  label: string; // "5-hour" / "7-day"
  resetsIn?: string; // "resets in 2h" (relative, if known)
  status?: "ok" | "warn" | "limited"; // shown when pct is unknown (status-only window)
}
export interface UsageAcct {
  id: string; // account id — the stable key callers match on (labels can drift)
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
  provider?: string; // catalog provider id (e.g. "openai") — used to resolve budgets
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
    const { name, kind, provider, balanceExposed, limitNote } = info(u.accountId);
    const tok = `${fmtTok(u.inputTokens)}/${fmtTok(u.outputTokens)}`;
    if (u.estimated) estimated = true;
    if (kind === "sub") {
      const snaps = u.rates ?? (u.rate ? [u.rate] : []);
      // Stable order: 5-hour before 7-day before anything else.
      const order = (t?: string) => (t === "five_hour" ? 0 : t === "seven_day" ? 1 : 2);
      const limits: LimitWindow[] = snaps
        .slice()
        .sort((a, b) => order(a.type) - order(b.type))
        .map((r): LimitWindow => {
          const meta = [resetsIn(r.resetsAt, now), observedAgo(r.at, now)].filter(Boolean).join(" · ");
          // A window whose reset time has passed has ROLLED OVER — the stored %
          // is from the previous window, so don't show it as the current number.
          // Drop to status-only "ok" (a just-reset window has headroom); the next
          // probe fills the real figure.
          const expired = typeof r.resetsAt === "number" && r.resetsAt * 1000 < now;
          if (typeof r.utilization === "number" && !expired) {
            return { pct: Math.round(r.utilization * 100), label: prettyLimit(r.type), resetsIn: meta || undefined };
          }
          // No number (or expired) — fall back to the provider's status word.
          const status = r.status === "rejected" ? "limited" : r.status === "allowed_warning" || r.status === "warning" ? "warn" : "ok";
          return { label: prettyLimit(r.type), resetsIn: expired ? observedAgo(r.at, now) : meta || undefined, status };
        });
      subscriptions.push({ id: u.accountId, name, turns: u.turns, tok, limits: limits.length ? limits : undefined, limitNote: limits.length ? undefined : limitNote ?? "limits not observed yet" });
    } else {
      apiTotal += u.spentUSD;
      const acct: UsageAcct = { id: u.accountId, name, turns: u.turns, tok, spend: (u.estimated ? "~" : "") + usd(u.spentUSD) + " spent", spendPos: u.spentUSD > 0 };
      if (u.balance?.remainingUSD != null) {
        acct.balanceLeft = usd(u.balance.remainingUSD) + " left";
        if (u.balance.totalUSD) acct.balanceFrac = Math.max(0, Math.min(1, u.balance.remainingUSD / u.balance.totalUSD));
      } else if (!balanceExposed) {
        // Check for a user-declared budget (self-declared spend cap → estimated remaining).
        const budget = budgetFor(id, provider);
        if (budget) {
          const spent = spentInPeriod(u, budget.period, now);
          const remaining = budget.amountUSD - spent;
          acct.balanceLeft = "~" + usd(Math.max(0, remaining)) + " left";
          acct.balanceFrac = Math.max(0, Math.min(1, remaining / budget.amountUSD));
        } else if (u.spentUSD > 0 && provider) {
          // Nudge: first spend with no balance visibility → suggest setting a budget.
          acct.balanceNote = `/budget ${provider} <amount>`;
        }
      }
      // Per-minute API rate-limit headroom from response headers (api:* windows).
      // API keys have no 5h/weekly plan window, so this is the live "% used" bar.
      // These windows reset every minute, so a stale one (observed > 5 min ago) is
      // meaningless noise — only show fresh ones.
      const API_FRESH_MS = 5 * 60_000;
      const apiLimits: LimitWindow[] = (u.rates ?? (u.rate ? [u.rate] : []))
        .filter((r) => (r.type ?? "").startsWith("api:") && typeof r.utilization === "number" && now - r.at < API_FRESH_MS)
        .sort((a, b) => (a.type === "api:requests" ? 0 : 1) - (b.type === "api:requests" ? 0 : 1))
        .map((r) => ({ pct: Math.round(r.utilization! * 100), label: prettyLimit(r.type), resetsIn: [resetsIn(r.resetsAt, now), observedAgo(r.at, now)].filter(Boolean).join(" · ") || undefined }));
      if (apiLimits.length) acct.limits = apiLimits;
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
