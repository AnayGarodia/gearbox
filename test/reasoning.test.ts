import { test, expect } from "bun:test";
import { reasoningOptions } from "../src/model/reasoning.ts";
import { findModel } from "../src/providers.ts";

const opus = findModel("claude-opus-4-8")!;
const gpt = findModel("gpt-5.5")!;
const gpro = findModel("gemini-3.1-pro-preview")!;
const haiku = findModel("claude-haiku-4-5")!;

test("effort maps to each provider's documented reasoning option", () => {
  // OpenAI reasoningEffort
  expect(reasoningOptions(gpt, "fast")).toEqual({ openai: { reasoningEffort: "low" } });
  expect(reasoningOptions(gpt, "balanced")).toEqual({ openai: { reasoningEffort: "medium" } });
  expect(reasoningOptions(gpt, "max")).toEqual({ openai: { reasoningEffort: "high" } });

  // Google thinkingConfig
  expect(reasoningOptions(gpro, "max")).toEqual({ google: { thinkingConfig: { thinkingLevel: "high" } } });

  // Anthropic: adaptive only nudged up at max; default otherwise (no param)
  expect(reasoningOptions(opus, "fast")).toEqual({});
  expect(reasoningOptions(opus, "max")).toEqual({ anthropic: { thinking: { type: "adaptive" } } });
});

test("models without a reasoning capability get no options", () => {
  expect(haiku.reasoning).toBeFalsy();
  expect(reasoningOptions(haiku, "max")).toEqual({});
});
