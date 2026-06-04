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
  type?: string; // e.g. "seven_day"
  at: number; // when we recorded it
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
  rate?: RateSnapshot;
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
  f.accounts[opts.accountId] = u;
  save(f);
}

/** Record the latest rate-limit / quota snapshot for an account (claude CLI). */
export function recordRateLimit(accountId: string, rate: Omit<RateSnapshot, "at">): void {
  const f = load();
  const u = f.accounts[accountId];
  if (!u) return;
  u.rate = { ...rate, at: Date.now() };
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

// Structured /usage view — the data both renderers (inline + fullscreen) draw
// bars from, so they stay identical. Columns are pre-padded here.
export interface UsageRow {
  name: string; // padded to the account column width
  spend: string; // padded, right-aligned (e.g. "$0.24~")
  spendFrac: number; // 0..1 of the largest spend (the bar)
  meta: string; // "3 turns · 13/3.8k"
  limitPct?: number; // 0..100
  limitLabel?: string; // "7-day"
}
export interface UsageView {
  rows: UsageRow[];
  barWidth: number;
  total: string;
  totalPad: number; // = account column width, so total/labels align
  sessionUSD?: string;
  hasEstimate: boolean;
}

export function buildUsageView(sessionUSD?: number, labelFor?: (id: string) => string): UsageView {
  const rows = loadUsage();
  const maxSpend = Math.max(0, ...rows.map((u) => u.spentUSD));
  const view = rows.map((u) => ({
    name: labelFor ? labelFor(u.accountId) : u.accountId,
    spendRaw: usd(u.spentUSD) + (u.estimated ? "~" : ""),
    spendFrac: maxSpend > 0 ? u.spentUSD / maxSpend : 0,
    meta: `${u.turns} turn${u.turns === 1 ? "" : "s"} · ${fmtTok(u.inputTokens)}/${fmtTok(u.outputTokens)}`,
    limitPct: u.rate ? Math.round(u.rate.utilization * 100) : undefined,
    limitLabel: u.rate ? prettyLimit(u.rate.type) : undefined,
  }));
  const nameW = Math.max("total".length, ...view.map((v) => v.name.length));
  const spendW = Math.max(...view.map((v) => v.spendRaw.length), usd(totalSpent()).length, 1);
  return {
    rows: view.map((v) => ({ name: v.name.padEnd(nameW), spend: v.spendRaw.padStart(spendW), spendFrac: v.spendFrac, meta: v.meta, limitPct: v.limitPct, limitLabel: v.limitLabel })),
    barWidth: 16,
    total: usd(totalSpent()).padStart(spendW),
    totalPad: nameW,
    sessionUSD: sessionUSD != null ? usd(sessionUSD) : undefined,
    hasEstimate: rows.some((u) => u.estimated),
  };
}

