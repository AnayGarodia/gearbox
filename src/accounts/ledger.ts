// The single spend writer (roadmap "canonical ledger", step 1). Every dollar a
// turn or a delegated sub-task spends flows through recordSpend(), which
// (a) updates the per-account aggregates in usage.json (recordUsage — unchanged
// on-disk shape, no migration), (b) appends one event line to ledger.jsonl
// (append-only: inherently crash-safe, and the at-the-time record a future
// /why or per-repo-priors engine reads — re-running estimateCost re-prices
// history when price tables change; the log preserves what was actually
// recorded), and (c) notifies an optional subscriber so the UI and the
// session's TurnMeta record derive from the SAME event instead of being
// assembled in parallel (TRIAGE R2: "no single source of truth").
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { recordUsage } from "./usage.ts";
import { estimateCost } from "../providers.ts";
import type { TurnMeta } from "../session.ts";

export interface SpendEvent {
  accountId: string;
  model: string;
  source: "turn" | "delegate" | "aux"; // aux = classifier/titles/commit-gen — small helper calls outside the turn
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD: number;
  estimated: boolean;
  at: number;
  /** WIRE TRUTH: the model id the provider/CLI reported actually served the
   *  call, when exposed. Absent = the backend didn't report one. */
  servedModel?: string;
}

/** The one cost policy, lifted out of App.tsx so the main turn and delegation
 *  can't derive cost differently: a flat-rate subscription seat is $0 marginal
 *  (the CLI's reported dollars are metered-equivalent fiction — S-F); a
 *  provider-reported real figure wins next; else estimate from tokens × list
 *  price, cache-aware. Pure. */
export function resolveTurnCost(opts: {
  modelId: string;
  isSub: boolean;
  cliCostUSD?: number;
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; cacheCreationInputTokens?: number };
}): { costUSD: number; estimated: boolean } {
  if (opts.isSub) return { costUSD: 0, estimated: false };
  if (opts.cliCostUSD != null) return { costUSD: opts.cliCostUSD, estimated: false };
  return {
    costUSD: estimateCost([{ model: opts.modelId, ...opts.usage }]),
    estimated: true,
  };
}

/** Project a spend event onto the session's per-turn shape, so the session
 *  record is a derivation of the event, never a second hand-built copy. */
export function turnMetaOf(ev: SpendEvent): TurnMeta {
  return {
    model: ev.model,
    inputTokens: ev.inputTokens,
    outputTokens: ev.outputTokens,
    cachedInputTokens: ev.cachedInputTokens,
    cacheCreationInputTokens: ev.cacheCreationInputTokens,
    at: ev.at,
    servedModel: ev.servedModel,
  };
}

function home(): string {
  return process.env.GEARBOX_HOME || join(homedir(), ".gearbox");
}

let listener: ((ev: SpendEvent) => void) | null = null;

/** App installs this (mirrors permission.ts setPermissionHandler) so delegate
 *  spend reaches the live session/strip without delegate.ts importing UI. */
export function setSpendListener(fn: ((ev: SpendEvent) => void) | null): void {
  listener = fn;
}

/** Per-day spend totals from the append-only event log (newest last) — the
 *  cost tab's daily bars. Reads the tail only (a long-lived log can't slow a
 *  tab switch); days with no events are zero-filled so the bars line up. */
export function readDailySpend(days = 7, now = Date.now()): { day: string; usd: number }[] {
  const byDay = new Map<string, number>();
  try {
    const raw = readFileSync(join(home(), "ledger.jsonl"), "utf8");
    const lines = raw.split("\n");
    const tail = lines.slice(Math.max(0, lines.length - 20_000));
    for (const line of tail) {
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (typeof ev?.at !== "number" || typeof ev?.costUSD !== "number") continue;
        const day = new Date(ev.at).toISOString().slice(0, 10);
        byDay.set(day, (byDay.get(day) ?? 0) + ev.costUSD);
      } catch { /* skip torn line */ }
    }
  } catch { /* no log yet */ }
  const out: { day: string; usd: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ day, usd: byDay.get(day) ?? 0 });
  }
  return out;
}

/** Today's spend on AUX calls (classifier/titles/commit-gen) — the cost tab
 *  shows it so no dollar is invisible. Tail-read like readDailySpend. */
export function readAuxSpendToday(now = Date.now()): number {
  const today = new Date(now).toISOString().slice(0, 10);
  let sum = 0;
  try {
    const lines = readFileSync(join(home(), "ledger.jsonl"), "utf8").split("\n");
    for (const line of lines.slice(Math.max(0, lines.length - 20_000))) {
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (ev?.source === "aux" && typeof ev.costUSD === "number" && new Date(ev.at).toISOString().slice(0, 10) === today) sum += ev.costUSD;
      } catch { /* torn line */ }
    }
  } catch { /* no log */ }
  return sum;
}

/** THE spend writer. Everything that costs money calls this — nothing else
 *  calls recordUsage directly (tests excepted). Returns the event so callers
 *  can reuse the exact recorded figures (e.g. the routing line's cost). */
export function recordSpend(ev: SpendEvent): SpendEvent {
  recordUsage({
    accountId: ev.accountId,
    inputTokens: ev.inputTokens,
    outputTokens: ev.outputTokens,
    costUSD: ev.costUSD,
    estimated: ev.estimated,
  });
  try {
    mkdirSync(home(), { recursive: true });
    appendFileSync(join(home(), "ledger.jsonl"), JSON.stringify(ev) + "\n", { mode: 0o600 });
  } catch {
    /* the event log is best-effort; aggregates already landed */
  }
  try {
    listener?.(ev);
  } catch {
    /* a UI subscriber must never break spend recording */
  }
  return ev;
}
