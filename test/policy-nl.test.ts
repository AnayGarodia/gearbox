// Deterministic fast-path tests for the plain-English policy parser.
// No network: only parsePolicyFast (pure) is exercised.
import { describe, expect, test } from "bun:test";
import { parsePolicyFast, type PolicyCtx } from "../src/model/policy-nl.ts";

const ctx: PolicyCtx = {
  providers: ["anthropic", "openai", "google", "deepseek", "moonshot", "zai", "minimax", "groq", "mistral"],
  models: ["claude-sonnet-4-5", "gpt-5", "gemini-2.5-pro", "deepseek-chat", "kimi-k2"],
  accounts: [
    { id: "a1", slug: "claude-work" },
    { id: "a2", slug: "openai-personal" },
    { id: "a3", slug: "deepseek-main" },
  ],
};

describe("avoid / allow", () => {
  test("don't use a provider", () => {
    expect(parsePolicyFast("don't use deepseek", ctx)).toEqual({ avoidProviders: { add: ["deepseek"] } });
  });
  test("avoid multiple providers", () => {
    expect(parsePolicyFast("avoid deepseek and groq", ctx)).toEqual({ avoidProviders: { add: ["deepseek", "groq"] } });
  });
  test("no <provider>", () => {
    expect(parsePolicyFast("no mistral", ctx)).toEqual({ avoidProviders: { add: ["mistral"] } });
  });
  test("chinese models expands to the chinese providers", () => {
    expect(parsePolicyFast("never use chinese models", ctx)).toEqual({
      avoidProviders: { add: ["deepseek", "moonshot", "zai", "minimax"] },
    });
  });
  test("avoid a model (matched against ctx.models, not providers)", () => {
    expect(parsePolicyFast("avoid kimi-k2", ctx)).toEqual({ avoidModels: { add: ["kimi-k2"] } });
  });
  test("allow removes a provider from the avoid list", () => {
    expect(parsePolicyFast("allow deepseek", ctx)).toEqual({ avoidProviders: { remove: ["deepseek"] } });
  });
  test("unblock a model", () => {
    expect(parsePolicyFast("unblock gpt-5", ctx)).toEqual({ avoidModels: { remove: ["gpt-5"] } });
  });
  test("unknown name → null (don't guess)", () => {
    expect(parsePolicyFast("avoid frobnicator", ctx)).toBeNull();
  });
});

describe("account order", () => {
  test("use A before B", () => {
    expect(parsePolicyFast("use claude-work before openai-personal", ctx)).toEqual({
      accountOrder: { set: ["claude-work", "openai-personal"] },
    });
  });
  test("A first, then B", () => {
    expect(parsePolicyFast("claude-work first, then deepseek-main", ctx)).toEqual({
      accountOrder: { set: ["claude-work", "deepseek-main"] },
    });
  });
  test("non-account names don't form an order", () => {
    expect(parsePolicyFast("use anthropic before google", ctx)).toBeNull();
  });
});

describe("budget", () => {
  test("i have $N of provider credits", () => {
    expect(parsePolicyFast("i have $40 of openai credits", ctx)).toEqual({
      budget: { key: "openai", amountUSD: 40, period: "total" },
    });
  });
  test("$N in provider", () => {
    expect(parsePolicyFast("$25 in deepseek", ctx)).toEqual({
      budget: { key: "deepseek", amountUSD: 25, period: "total" },
    });
  });
  test("decimal amounts parse", () => {
    expect(parsePolicyFast("i have $12.50 of groq credits", ctx)).toEqual({
      budget: { key: "groq", amountUSD: 12.5, period: "total" },
    });
  });
  test("two providers mentioned → ambiguous → null", () => {
    expect(parsePolicyFast("i have $40 of openai and deepseek credits", ctx)).toBeNull();
  });
});

describe("use first", () => {
  test("burn provider credits first", () => {
    expect(parsePolicyFast("burn my openai credits first", ctx)).toEqual({ useFirst: { set: ["openai"] } });
  });
  test("spend account first (slug wins over provider)", () => {
    expect(parsePolicyFast("spend deepseek-main first", ctx)).toEqual({ useFirst: { set: ["deepseek-main"] } });
  });
  test("use provider first", () => {
    expect(parsePolicyFast("use groq first", ctx)).toEqual({ useFirst: { set: ["groq"] } });
  });
});

describe("prefer", () => {
  test("subscriptions only", () => {
    expect(parsePolicyFast("subscriptions only", ctx)).toEqual({ prefer: "subscription" });
  });
  test("api only", () => {
    expect(parsePolicyFast("api only", ctx)).toEqual({ prefer: "api" });
  });
  test("no preference clears", () => {
    expect(parsePolicyFast("no preference", ctx)).toEqual({ prefer: null });
  });
});

describe("ambiguity", () => {
  test("unrelated sentence → null", () => {
    expect(parsePolicyFast("fix the bug in app.tsx", ctx)).toBeNull();
  });
  test("empty → null", () => {
    expect(parsePolicyFast("   ", ctx)).toBeNull();
  });
  test("vague preference → null (escalates to LLM)", () => {
    expect(parsePolicyFast("i'd rather not pay too much for routine stuff", ctx)).toBeNull();
  });
});
