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
