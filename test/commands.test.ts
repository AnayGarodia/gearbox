import { test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchCommands, commandNameMatches, helpText, formatModelList, resolveModelSwitch, COMMANDS } from "../src/commands.ts";

// Isolate the account store so model resolution is deterministic and never reads
// the developer's real ~/.gearbox (whose discovered accounts would change which
// models a fuzzy name matches — e.g. an Azure account that also serves Haiku).
beforeEach(() => {
  process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gearbox-cmd-"));
  process.env.GEARBOX_SECRET_STORE = "file";
});
afterAll(() => {
  delete process.env.GEARBOX_HOME;
  delete process.env.GEARBOX_SECRET_STORE;
});

test("matchCommands filters by prefix", () => {
  expect(matchCommands("/mo").map((c) => c.name)).toEqual(["/model"]);
  expect(matchCommands("/").length).toBe(COMMANDS.length);
  expect(matchCommands("hello").length).toBe(0);
});

test("commandNameMatches suppresses matches once you're typing arguments", () => {
  // Still typing the name → suggest (so the palette + tab-complete work).
  expect(commandNameMatches("/as").map((c) => c.name)).toContain("/ask");
  expect(commandNameMatches("/").length).toBe(COMMANDS.length);
  expect(commandNameMatches("/ask").map((c) => c.name)).toEqual(["/ask"]);
  // A space after the name = arguments. The name is settled, so no match —
  // otherwise the lone match keeps the palette active and it swallows ↑/↓,
  // blocking prompt-history navigation (the /ask + /prefer "stuck arrows" bug).
  expect(commandNameMatches("/ask how do I route")).toEqual([]);
  expect(commandNameMatches("/prefer code haiku")).toEqual([]);
  expect(commandNameMatches("/ask ")).toEqual([]);
  expect(commandNameMatches("hello there")).toEqual([]);
});

test("helpText lists every command", () => {
  const h = helpText();
  for (const c of COMMANDS) expect(h).toContain(c.name);
});

test("formatModelList marks current and lists available labels", () => {
  // formatModelList shows models whose provider is available; give it keys.
  const saved = { a: process.env.ANTHROPIC_API_KEY, o: process.env.OPENAI_API_KEY };
  process.env.ANTHROPIC_API_KEY = "x";
  process.env.OPENAI_API_KEY = "x";
  try {
    const out = formatModelList("claude-sonnet-4-6");
    expect(out).toContain("sonnet-4.6");
    expect(out).toContain("gpt-5.5");
    expect(out).toContain("●");
  } finally {
    if (saved.a === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.a;
    if (saved.o === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved.o;
  }
});

import { modelRank, compareModels, modelMarker, buildContextView, orderModelsForDisplay } from "../src/commands.ts";

test("buildContextView reports each section's share of the window", () => {
  const v = buildContextView([{ name: "system", tokens: 10_000 }, { name: "history", tokens: 240 }], 200_000, "/repo");
  expect(v.rows[0]!.pct).toBe(5);
  expect(v.rows[1]!.pct).toBe(0.1); // sub-1% keeps a decimal — doesn't read as zero
  expect(v.windowPct).toBe(5);
  // without a window, pct is absent (nothing to be a percentage OF)
  const noWin = buildContextView([{ name: "system", tokens: 10_000 }]);
  expect(noWin.rows[0]!.pct).toBeUndefined();
});
import type { ModelSpec } from "../src/providers.ts";

test("modelRank/compareModels: curated → discovered → seeds → pin-only, quality desc, label ties", () => {
  const curated: ModelSpec = { id: "a", provider: "openai", sdkId: "a", label: "alpha", contextWindow: 1, quality: 0.7 };
  const curatedBetter: ModelSpec = { id: "b", provider: "openai", sdkId: "b", label: "beta", contextWindow: 1, quality: 0.9 };
  const discovered: ModelSpec = { id: "c", provider: "openai", sdkId: "c", label: "gamma", contextWindow: 1, capabilities: { source: "api-discovered" } };
  const seeded: ModelSpec = { id: "d", provider: "openai", sdkId: "d", label: "delta", contextWindow: 1, capabilities: { source: "seeded" } };
  const pinOnly: ModelSpec = { id: "e", provider: "openai", sdkId: "e", label: "epsilon", contextWindow: 1, routable: false };
  const sorted = [pinOnly, seeded, discovered, curated, curatedBetter].sort(compareModels);
  expect(sorted.map((m) => m.id)).toEqual(["b", "a", "c", "d", "e"]);
  expect(modelRank(curated)).toBe(0);
  expect(modelRank(discovered)).toBe(1);
  expect(modelRank(seeded)).toBe(2);
  expect(modelRank(pinOnly)).toBe(3);
  // Ties inside a rank break alphabetically — the list is fully deterministic.
  const t1: ModelSpec = { ...discovered, id: "z", label: "zz" };
  expect([t1, discovered].sort(compareModels).map((m) => m.id)).toEqual(["c", "z"]);
});

test("orderModelsForDisplay: scoped account first, then any added account, then env-only — never buried by static rank", () => {
  // The reported bug: a discovered azure-foundry model (the account routing is
  // scoped to) sat at the END of the static registry behind curated openai/google
  // seeds, so the /model palette's slice(0,7) cut it off entirely.
  const opus: ModelSpec = { id: "anthropic/opus", provider: "anthropic", sdkId: "opus", label: "opus", contextWindow: 1, quality: 0.95 };
  const gpt: ModelSpec = { id: "openai/gpt", provider: "openai", sdkId: "gpt", label: "gpt", contextWindow: 1, quality: 0.9 };
  const gemini: ModelSpec = { id: "google/gemini", provider: "google", sdkId: "gemini", label: "gemini", contextWindow: 1, quality: 0.88 };
  const deepseek: ModelSpec = { id: "azure-foundry/DeepSeek-V4-Flash", provider: "azure-foundry", sdkId: "DeepSeek-V4-Flash", label: "DeepSeek-V4-Flash", contextWindow: 1, capabilities: { source: "api-discovered" } };
  const registry = [opus, gpt, gemini, deepseek]; // static order: curated first, discovered last

  // Routing scoped to the azure-foundry account → its models lead.
  const scoped = orderModelsForDisplay(registry, { accountProviders: new Set(["anthropic", "azure-foundry"]), scopedProvider: "azure-foundry" });
  expect(scoped[0]!.id).toBe("azure-foundry/DeepSeek-V4-Flash");
  // anthropic (a saved account) outranks openai/google (env-only) even though they're curated.
  expect(scoped.findIndex((m) => m.provider === "anthropic")).toBeLessThan(scoped.findIndex((m) => m.provider === "openai"));

  // Unscoped: saved accounts (anthropic, azure-foundry) still beat env-only providers.
  const unscoped = orderModelsForDisplay(registry, { accountProviders: new Set(["anthropic", "azure-foundry"]) });
  const lastAccount = Math.max(unscoped.findIndex((m) => m.provider === "anthropic"), unscoped.findIndex((m) => m.provider === "azure-foundry"));
  expect(lastAccount).toBeLessThan(unscoped.findIndex((m) => m.provider === "openai"));

  // No opts → falls back to plain compareModels (back-compat).
  expect(orderModelsForDisplay(registry, {}).map((m) => m.id)).toEqual([...registry].sort(compareModels).map((m) => m.id));
});

test("modelMarker tags provenance honestly", () => {
  expect(modelMarker({ id: "x", provider: "openai", sdkId: "x", label: "x", contextWindow: 1 })).toBe("");
  expect(modelMarker({ id: "x", provider: "openai", sdkId: "x", label: "x", contextWindow: 1, capabilities: { source: "api-discovered" } })).toContain("discovered");
  expect(modelMarker({ id: "x", provider: "openai", sdkId: "x", label: "x", contextWindow: 1, capabilities: { source: "seeded" } })).toContain("seed");
  expect(modelMarker({ id: "x", provider: "openai", sdkId: "x", label: "x", contextWindow: 1, routable: false })).toContain("pin-only");
});

test("formatModelList orders each provider by rank+quality, not registry order", () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "x";
  try {
    const out = formatModelList(null);
    // The anthropic block lists curated models best-quality-first; all three appear.
    const idx = (s: string) => out.indexOf(s);
    expect(idx("opus-4.8")).toBeGreaterThan(-1);
    expect(idx("sonnet-4.6")).toBeGreaterThan(-1);
    expect(idx("haiku-4.5")).toBeGreaterThan(-1);
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved;
  }
});

test("resolveModelSwitch is fuzzy: substring, no-match, no-key, ambiguous, exact", () => {
  const KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "DEEPSEEK_API_KEY"];
  const saved: Record<string, string | undefined> = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    process.env.ANTHROPIC_API_KEY = "x";
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "x";

    // a string that matches no model id/label
    expect(resolveModelSwitch("zzznotamodel").ok).toBe(false);
    // "haiku" → the one haiku model (anthropic key present)
    expect(resolveModelSwitch("haiku")).toMatchObject({ ok: true, modelId: "claude-haiku-4-5" });
    // "gemini" matches two available google models → ambiguous
    const g = resolveModelSwitch("gemini");
    expect(g.ok).toBe(false);
    expect(g.message).toContain("be more specific");
    // exact label resolves even when it's a substring of another
    expect(resolveModelSwitch("gemini-3.5-flash")).toMatchObject({ ok: true, modelId: "gemini-3.5-flash" });
    // matches a model whose provider has no key
    expect(resolveModelSwitch("gpt").ok).toBe(false);
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

import { modelDirectiveIn } from "../src/commands.ts";

test("modelDirectiveIn pins on an explicit model alias, ignores ordinary prose", () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "x"; // make anthropic models available to resolve
  try {
    expect(modelDirectiveIn("use opus to write 150 lines of code")).toBe("claude-opus-4-8");
    expect(modelDirectiveIn("with haiku, summarize this")).toBe("claude-haiku-4-5");
    expect(modelDirectiveIn("run sonnet on the repo")).toBe("claude-sonnet-4-6");
    // NOT directives — ordinary words after use/with/on must not pin a model
    expect(modelDirectiveIn("use the existing auth framework")).toBeNull();
    expect(modelDirectiveIn("refactor with care and add tests")).toBeNull();
    expect(modelDirectiveIn("focus on main.ts")).toBeNull();
    expect(modelDirectiveIn("write 150 lines of code")).toBeNull();
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev;
  }
});

import { closestCommand, editDistance } from "../src/commands.ts";

test("slash typos suggest the real command (transpositions included)", () => {
  expect(editDistance("accoutn", "account")).toBe(1); // one transposition
  expect(closestCommand("accoutn")).toBe("/account");
  expect(closestCommand("modle")).toBe("/model");
  expect(closestCommand("zzzzzz")).toBeNull();
});
