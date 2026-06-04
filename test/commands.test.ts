import { test, expect } from "bun:test";
import { matchCommands, helpText, formatModelList, resolveModelSwitch, COMMANDS } from "../src/commands.ts";

test("matchCommands filters by prefix", () => {
  expect(matchCommands("/mo").map((c) => c.name)).toEqual(["/model"]);
  expect(matchCommands("/").length).toBe(COMMANDS.length);
  expect(matchCommands("hello").length).toBe(0);
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
