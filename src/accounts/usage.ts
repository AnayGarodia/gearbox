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
export function formatUsage(sessionUSD?: number): string {
  const rows = loadUsage();
  const lines: string[] = ["cost · per-account spend (all sessions)"];
  if (!rows.length) lines.push("  (nothing recorded yet)");
  for (const u of rows) {
    const tok = `${fmtTok(u.inputTokens)}/${fmtTok(u.outputTokens)} tok`;
    const limit = u.rate ? ` · ${Math.round(u.rate.utilization * 100)}% of ${u.rate.type ?? "limit"}` : "";
    lines.push(`  ${u.accountId.padEnd(20)} ${usd(u.spentUSD).padStart(8)}${u.estimated ? "~" : " "} ${u.turns} turns · ${tok}${limit}`);
  }
  lines.push(`  ${"total".padEnd(20)} ${usd(totalSpent()).padStart(8)}`);
  if (sessionUSD != null) lines.push(`\n  this session (est): ${usd(sessionUSD)}`);
  lines.push("\n  ~ = includes estimated figures (provider didn't report exact cost)");
  return lines.join("\n");
}
