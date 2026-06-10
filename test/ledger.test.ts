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

test("a torn usage.json is preserved as .corrupt, not silently discarded", () => {
  writeFileSync(join(home, "usage.json"), "{ this is not json");
  recordSpend(ev()); // load() hits the corrupt file, preserves it, starts fresh
  expect(existsSync(join(home, "usage.json.corrupt"))).toBe(true);
  expect(accountUsage("acct-1")!.turns).toBe(1);
});

import { readAuxSpendToday } from "../src/accounts/ledger.ts";

test("aux spend (classifier/titles) hits the ledger and is reportable — no invisible dollars", () => {
  const seen: any[] = [];
  setSpendListener((ev) => seen.push(ev));
  recordSpend({ accountId: "acct-1", model: "claude-haiku-4-5", source: "aux", inputTokens: 900, outputTokens: 4, costUSD: 0.0011, estimated: true, at: Date.now() });
  setSpendListener(null);
  expect(seen[0]?.source).toBe("aux");
  expect(readAuxSpendToday()).toBeGreaterThan(0);
});
