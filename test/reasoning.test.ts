import { test, expect } from "bun:test";
import { effortLevels, normalizeEffort, reasoningOptions } from "../src/model/reasoning.ts";
import { findModel } from "../src/providers.ts";

const opus = findModel("claude-opus-4-8")!;
const sonnet = findModel("claude-sonnet-4-6")!;
const gpt = findModel("gpt-5.5")!;
const gpro = findModel("gemini-3.1-pro-preview")!;
const haiku = findModel("claude-haiku-4-5")!;

test("effort maps to each provider's documented reasoning option", () => {
  // gpt-5.5 is gpt-5.1+ family: docs accept none/low/medium/high — NOT xhigh or
  // minimal — so the curated efforts list is clamped to the contract vocab. (#9)
  expect(effortLevels(gpt)).not.toContain("xhigh");
  expect(effortLevels(gpt)).not.toContain("minimal");
  expect(reasoningOptions(gpt, "high")).toEqual({ openai: { reasoningEffort: "high" } });
  expect(reasoningOptions(gpt, "xhigh")).toEqual({}); // not in vocab → nothing sent
  expect(reasoningOptions(gpt, "max")).toEqual({});

  // Google thinkingConfig — Gemini vocab is low/high; curated minimal/medium are
  // clamped out so we never emit a thinkingLevel the enum rejects. (#10)
  expect(effortLevels(gpro)).toEqual(["low", "high"]);
  expect(reasoningOptions(gpro, "high")).toEqual({ google: { thinkingConfig: { thinkingLevel: "high" } } });

  expect(effortLevels(opus)).toContain("max");
  expect(reasoningOptions(opus, "max")).toEqual({ anthropic: { effort: "max" } });
  expect(reasoningOptions(opus, "xhigh")).toEqual({ anthropic: { effort: "xhigh" } });
  expect(effortLevels(sonnet)).not.toContain("xhigh");
  expect(reasoningOptions(sonnet, "xhigh")).toEqual({});
  expect(normalizeEffort("extra high", effortLevels(opus))).toBe("xhigh");
  expect(normalizeEffort("balanced", effortLevels(gpt))).toBe("medium");
});

test("Root A: reasoningOptions dispatches on contract shape, not provider allowlist", () => {
  // Bedrock Claude resolves shape=anthropic-thinking — it must emit the thinking
  // effort, not {} (the old provider allowlist excluded bedrock → dead effort). (#1)
  const bedrockSonnet = findModel("bedrock/anthropic.claude-sonnet-4-20250514-v1:0");
  if (bedrockSonnet) {
    expect(reasoningOptions(bedrockSonnet, "max")).toEqual({ anthropic: { effort: "max" } });
  }
});

test("models without a reasoning capability get no options", () => {
  expect(haiku.reasoning).toBeFalsy();
  expect(reasoningOptions(haiku, "max")).toEqual({});
});
