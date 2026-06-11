// Routing-engine fixes: (model, account) candidate identity, prior-aware
// escalation promotion, classifier context stickiness, and real estTokens
// activating the context-window fit filter.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoutingSelector } from "../src/model/router.ts";
import { scoreCandidate, type ScoreCandidate } from "../src/model/scoring.ts";
import { putAccount } from "../src/accounts/store.ts";
import { recordBalance, recordUsage } from "../src/accounts/usage.ts";
import { recordTurnOutcome, clearPriorsCache } from "../src/model/priors.ts";
import { clearCooldowns } from "../src/model/cooldown.ts";
import { classifyTask, isAnaphoric } from "../src/agent/classify.ts";
import type { Account } from "../src/accounts/types.ts";
import type { AccountState } from "../src/model/routing-context.ts";

const KEYS = ["ANTHROPIC_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEARBOX_HOME"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gearbox-rfix-"));
  process.env.ANTHROPIC_API_KEY = "k";
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  clearPriorsCache();
  clearCooldowns();
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  clearPriorsCache();
  clearCooldowns();
});

const acct = (id: string): Account => ({
  id, slug: id, label: id, provider: "anthropic", exec: "in-loop",
  auth: { kind: "api-key", ref: `${id}:api-key` }, enabled: true, addedAt: 0,
});

// ── FIX 1: unique (account, model) identity ──────────────────────────────────

test("select() returns the ACCOUNT that won, not the first account on the model", () => {
  // Two accounts serve the same anthropic models. Account "a" enumerates first
  // but has nearly-drained credit (heavy scarcity penalty); "b" is flush. With
  // identity keyed on spec.id alone, pickBest's winner (b's score) resolved
  // back to "a" via find-by-model-id.
  putAccount(acct("a"));
  putAccount(acct("b"));
  // recordBalance requires an existing usage row — seed one per account first.
  recordUsage({ accountId: "a", inputTokens: 1, outputTokens: 1, costUSD: 0, estimated: false });
  recordUsage({ accountId: "b", inputTokens: 1, outputTokens: 1, costUSD: 0, estimated: false });
  recordBalance("a", { remainingUSD: 0.01 });
  recordBalance("b", { remainingUSD: 500 });
  const choice = new RoutingSelector().select({ prompt: "refactor the parser", kind: "code" });
  expect(choice.backend?.kind).toBe("in-loop");
  expect((choice.backend as any).account?.id).toBe("b");
});

test("explain() shows one row per (model, account) instead of collapsing them", () => {
  putAccount(acct("a"));
  putAccount(acct("b"));
  const card = new RoutingSelector().explain!({ prompt: "refactor the parser", kind: "code" });
  // Every label+account pairing must be unique, and both accounts must appear.
  const keys = card.entries.map((e) => `${e.label}|${e.accountLabel}`);
  expect(new Set(keys).size).toBe(keys.length);
  const accounts = new Set(card.entries.map((e) => e.accountLabel));
  expect(accounts.has("a")).toBe(true);
  expect(accounts.has("b")).toBe(true);
});

test("warm match uses the bare modelId, not the composite candidate id", () => {
  const account: AccountState = { accountId: "a", provider: "anthropic", exec: "in-loop", isSubscription: false };
  const c: ScoreCandidate = {
    id: "a::sonnet", modelId: "sonnet", inUSDPerMtok: 3, outUSDPerMtok: 15,
    quality: 0.7, tps: 100, account, cacheReadDiscount: 0.1,
  };
  const warm = scoreCandidate(c, { candidates: [], now: 0, estInputTokens: 100_000, warm: { accountId: "a", modelId: "sonnet" } });
  expect(warm.terms.cacheSavings).toBeGreaterThan(0); // recognized as warm
  expect(warm.terms.switchPenalty).toBe(0);
});

// ── FIX 2: escalation promotion respects priors and known-weak seats ─────────

test("escalation promotion skips a model whose measured prior sank it", () => {
  // Find the model escalation would promote with no priors, sink it with
  // measured failures, and confirm promotion moves to a different model.
  const escalated = { prompt: "refactor the parser", kind: "code" as const, escalate: 10 };
  const baseline = new RoutingSelector().select(escalated);
  for (let i = 0; i < 12; i++) recordTurnOutcome({ kind: "code", modelId: baseline.model.id, outcome: "failed" });
  clearPriorsCache();
  const after = new RoutingSelector().select(escalated);
  expect(after.model.id).not.toBe(baseline.model.id);
});

test("escalation promotion does not hand the turn to a known-weak free seat", () => {
  // A Claude seat exposes haiku (free + fast). The old promotion admitted ALL
  // cli seats, so escalation could land on the weakest model — the opposite of
  // climbing. Known-quality seats are now held to the same strength test.
  putAccount({ id: "claude-max", label: "Claude Max", provider: "claude-cli", exec: "cli", auth: { kind: "cli", binary: "claude" }, enabled: true, addedAt: 0 });
  const choice = new RoutingSelector().select({ prompt: "refactor the parser", kind: "code", escalate: 10 });
  expect(choice.model.sdkId ?? choice.model.id).not.toContain("haiku");
});

// ── FIX 4: classifier context stickiness ─────────────────────────────────────

test("isAnaphoric: short continuations yes, fresh full prompts no", () => {
  expect(isAnaphoric("yes do it")).toBe(true);
  expect(isAnaphoric("same for the other file")).toBe(true);
  expect(isAnaphoric("continue where you left off please, thanks a lot")).toBe(true); // anaphora prefix beats length
  expect(isAnaphoric("please write a complete design document for the new caching layer")).toBe(false);
});

test("an anaphoric follow-up inherits the previous turn's kind", async () => {
  const r = await classifyTask("yes do it", undefined, { prevKind: "code" });
  expect(r).toEqual({ kind: "code", source: "context" });
  // Context verdicts must never be persisted — the cache is prompt-pure.
  expect(existsSync(join(process.env.GEARBOX_HOME!, "classify-cache.json"))).toBe(false);
});

test("a confident keyword match beats context inheritance", async () => {
  const r = await classifyTask("fix it", undefined, { prevKind: "chat" });
  expect(r).toEqual({ kind: "code", source: "keyword" });
});

test("no prevKind → no context path (old behavior preserved)", async () => {
  delete process.env.ANTHROPIC_API_KEY; // keyless → falls back, no network
  const r = await classifyTask("yes do it");
  expect(r.source).not.toBe("context");
});

// ── FIX 5: real estTokens engages the context-window fit filter ──────────────

test("a large estTokens routes to a model whose context window fits", () => {
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = "k"; // gemini: 1M-token window
  // 600k tokens (×1.2 headroom) overflows every 200k anthropic window; only
  // the gemini models fit, so the fit filter must carry the turn there.
  const choice = new RoutingSelector().select({ prompt: "summarize this giant transcript", kind: "summarize", estTokens: 600_000 });
  expect(choice.model.provider).toBe("google");
});
