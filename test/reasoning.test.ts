import { test, expect } from "bun:test";
import { effortLevels, normalizeEffort, reasoningOptions } from "../src/model/reasoning.ts";
import { findModel } from "../src/providers.ts";

const opus = findModel("claude-opus-4-8")!;
const gpt = findModel("gpt-5.5")!;
const gpro = findModel("gemini-3.1-pro-preview")!;
const haiku = findModel("claude-haiku-4-5")!;

test("effort maps to each provider's documented reasoning option", () => {
  expect(effortLevels(gpt)).toContain("xhigh");
  expect(reasoningOptions(gpt, "xhigh")).toEqual({ openai: { reasoningEffort: "xhigh" } });
  expect(reasoningOptions(gpt, "max")).toEqual({});

  // Google thinkingConfig
  expect(reasoningOptions(gpro, "high")).toEqual({ google: { thinkingConfig: { thinkingLevel: "high" } } });

  expect(effortLevels(opus)).toContain("max");
  expect(reasoningOptions(opus, "max")).toEqual({ anthropic: { effort: "max" } });
  expect(reasoningOptions(opus, "xhigh")).toEqual({ anthropic: { effort: "xhigh" } });
  expect(normalizeEffort("extra high", effortLevels(gpt))).toBe("xhigh");
  expect(normalizeEffort("balanced", effortLevels(gpt))).toBe("medium");
});

test("models without a reasoning capability get no options", () => {
  expect(haiku.reasoning).toBeFalsy();
  expect(reasoningOptions(haiku, "max")).toEqual({});
});
