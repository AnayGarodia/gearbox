// The single spend writer: aggregates + append-only event log + subscriber all
// derive from one recordSpend() event; cost policy is pure and shared.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordSpend, resolveTurnCost, turnMetaOf, setSpendListener, type SpendEvent } from "../src/accounts/ledger.ts";
import { accountUsage, totalSpent } from "../src/accounts/usage.ts";

let home: string;
const saved = process.env.GEARBOX_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "gearbox-ledger-"));
  process.env.GEARBOX_HOME = home;
});
afterEach(() => {
  setSpendListener(null);
  if (saved === undefined) delete process.env.GEARBOX_HOME;
  else process.env.GEARBOX_HOME = saved;
});

const ev = (over: Partial<SpendEvent> = {}): SpendEvent => ({
  accountId: "acct-1", model: "claude-sonnet-4-6", source: "turn",
  inputTokens: 1000, outputTokens: 200, costUSD: 0.0123, estimated: true, at: 1700000000000,
  ...over,
});

test("recordSpend writes the usage.json aggregate AND one jsonl event line", () => {
  recordSpend(ev());
  recordSpend(ev({ source: "delegate", costUSD: 0.005 }));
  const agg = accountUsage("acct-1")!;
  expect(agg.turns).toBe(2);
  expect(agg.spentUSD).toBeCloseTo(0.0173, 6);
  expect(totalSpent()).toBeCloseTo(0.0173, 6);
  const lines = readFileSync(join(home, "ledger.jsonl"), "utf8").trim().split("\n");
  expect(lines).toHaveLength(2);
  const first = JSON.parse(lines[0]!);
  expect(first.source).toBe("turn");
  expect(first.costUSD).toBeCloseTo(0.0123, 6);
  expect(JSON.parse(lines[1]!).source).toBe("delegate");
});

test("the spend listener sees every event and can't break recording", () => {
  const seen: SpendEvent[] = [];
  setSpendListener((e) => { seen.push(e); throw new Error("UI bug"); });
  recordSpend(ev());
  expect(seen).toHaveLength(1);
  expect(accountUsage("acct-1")!.turns).toBe(1); // aggregate landed despite the throw
});

test("resolveTurnCost: subscription seat = $0 real; CLI-reported wins; else cache-aware estimate", () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 0 };
  expect(resolveTurnCost({ modelId: "claude-sonnet-4-6", isSub: true, cliCostUSD: 9.99, usage })).toEqual({ costUSD: 0, estimated: false });
  expect(resolveTurnCost({ modelId: "claude-sonnet-4-6", isSub: false, cliCostUSD: 1.23, usage })).toEqual({ costUSD: 1.23, estimated: false });
  const est = resolveTurnCost({ modelId: "claude-sonnet-4-6", isSub: false, usage });
  expect(est.estimated).toBe(true);
  expect(est.costUSD).toBeGreaterThan(0);
  // Cache reads price at ~10% of input rate → cheaper than the uncached estimate.
  const cached = resolveTurnCost({ modelId: "claude-sonnet-4-6", isSub: false, usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 1_000_000 } });
  expect(cached.costUSD).toBeLessThan(est.costUSD);
  expect(cached.costUSD).toBeGreaterThan(0);
});

test("turnMetaOf projects the event onto the session TurnMeta shape", () => {
  const meta = turnMetaOf(ev({ cachedInputTokens: 42, cacheCreationInputTokens: 7 }));
  expect(meta).toEqual({
    model: "claude-sonnet-4-6", inputTokens: 1000, outputTokens: 200,
    cachedInputTokens: 42, cacheCreationInputTokens: 7, at: 1700000000000,
  });
});

test("the wire-reported served model rides the event into the session record", () => {
  // Trust chain: what the provider SAYS it served is recorded alongside what
  // we asked for, end to end (event → ledger.jsonl → session TurnMeta).
  const meta = turnMetaOf(ev({ servedModel: "claude-sonnet-4-6-20251114" }));
  expect(meta.servedModel).toBe("claude-sonnet-4-6-20251114");
  recordSpend(ev({ servedModel: "claude-sonnet-4-6-20251114" }));
  const line = JSON.parse(readFileSync(join(home, "ledger.jsonl"), "utf8").trim());
  expect(line.servedModel).toBe("claude-sonnet-4-6-20251114");
});

test("a torn usage.json is preserved as .corrupt, not silently discarded", () => {
  writeFileSync(join(home, "usage.json"), "{ this is not json");
  recordSpend(ev()); // load() hits the corrupt file, preserves it, starts fresh
  expect(existsSync(join(home, "usage.json.corrupt"))).toBe(true);
  expect(accountUsage("acct-1")!.turns).toBe(1);
});

import { readAuxSpendToday, readDailySpend } from "../src/accounts/ledger.ts";

test("aux spend (classifier/titles) hits the ledger and is reportable — no invisible dollars", () => {
  const seen: any[] = [];
  setSpendListener((ev) => seen.push(ev));
  recordSpend({ accountId: "acct-1", model: "claude-haiku-4-5", source: "aux", inputTokens: 900, outputTokens: 4, costUSD: 0.0011, estimated: true, at: Date.now() });
  setSpendListener(null);
  expect(seen[0]?.source).toBe("aux");
  expect(readAuxSpendToday()).toBeGreaterThan(0);
});

// Mirrors TAIL_BYTES in src/accounts/ledger.ts — the constant-size tail window
// the daily/aux readers pull instead of reading the whole append-only log.
const TAIL_BYTES = 2 * 1024 * 1024;

test("tail-read: a ledger far larger than the tail window still totals the recent events exactly", () => {
  const now = Date.UTC(2026, 5, 10, 12, 0, 0); // a fixed "today"
  const oldAt = now - 86_400_000; // yesterday
  const today = new Date(now).toISOString().slice(0, 10);
  const yesterday = new Date(oldAt).toISOString().slice(0, 10);

  // > 2× the tail window of old events, then a small set of recent ones.
  const oldLine = JSON.stringify({ at: oldAt, costUSD: 0.001, source: "turn" }) + "\n";
  const oldCount = Math.ceil((2.5 * TAIL_BYTES) / oldLine.length);
  const recent = Array.from({ length: 500 }, () => JSON.stringify({ at: now, costUSD: 0.01, source: "turn" }) + "\n").join("");
  const aux = Array.from({ length: 3 }, () => JSON.stringify({ at: now, costUSD: 0.002, source: "aux" }) + "\n").join("");
  writeFileSync(join(home, "ledger.jsonl"), oldLine.repeat(oldCount) + recent + aux);

  const byDay = new Map(readDailySpend(7, now).map((d) => [d.day, d.usd]));
  // Everything written inside the window (the newest events) is counted exactly.
  expect(byDay.get(today)).toBeCloseTo(500 * 0.01 + 3 * 0.002, 6);
  // Older events are window-limited (tail bytes + the 20k-line cap), never the
  // whole multi-MB file: some counted, strictly fewer than all of them.
  const yUsd = byDay.get(yesterday)!;
  expect(yUsd).toBeGreaterThan(0);
  expect(yUsd).toBeLessThan(oldCount * 0.001 - 1e-9);
  // Aux reader shares the same tail helper.
  expect(readAuxSpendToday(now)).toBeCloseTo(3 * 0.002, 6);
});

test("tail-read: a byte boundary that splits a line drops the partial first line cleanly", () => {
  const now = Date.UTC(2026, 5, 10, 12, 0, 0);
  const fillerAt = now - 2 * 86_400_000; // two days ago — outside the byte window
  const fillerDay = new Date(fillerAt).toISOString().slice(0, 10);
  const today = new Date(now).toISOString().slice(0, 10);

  // Tail-window events: N whole lines that must all be counted.
  const tailLines = Array.from({ length: 100 }, () => JSON.stringify({ at: now, costUSD: 0.01, source: "turn" }) + "\n").join("");
  // The victim: padded so the suffix (victim + tail lines) is exactly
  // TAIL_BYTES + 10 bytes → the read boundary lands 10 bytes INTO this line.
  const victimBase = { at: now, costUSD: 999, source: "turn", pad: "" };
  const baseLen = (JSON.stringify(victimBase) + "\n").length;
  const padLen = TAIL_BYTES + 10 - tailLines.length - baseLen;
  const victim = JSON.stringify({ ...victimBase, pad: "x".repeat(padLen) }) + "\n";
  expect(victim.length + tailLines.length).toBe(TAIL_BYTES + 10);
  // Some filler before it so the read doesn't start at offset 0.
  const filler = (JSON.stringify({ at: fillerAt, costUSD: 5, source: "turn" }) + "\n").repeat(50);
  writeFileSync(join(home, "ledger.jsonl"), filler + victim + tailLines);

  const byDay = new Map(readDailySpend(7, now).map((d) => [d.day, d.usd]));
  // The split victim ($999) is dropped, never half-parsed into garbage; every
  // whole line inside the window is counted exactly.
  expect(byDay.get(today)).toBeCloseTo(100 * 0.01, 6);
  // The filler sits entirely before the byte window → not counted.
  expect(byDay.get(fillerDay)).toBe(0);
});
