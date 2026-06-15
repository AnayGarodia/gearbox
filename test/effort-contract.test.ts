import { test, expect, describe } from "bun:test";
import { effortLevels, reasoningOptions } from "../src/model/reasoning.ts";
import type { ModelSpec } from "../src/providers.ts";

// A discovered/generated reasoning model carries no curated `efforts`; the
// contract now supplies the documented vocab so /effort clamps correctly.
function spec(partial: Partial<ModelSpec> & Pick<ModelSpec, "provider" | "sdkId">): ModelSpec {
  return { id: partial.sdkId, label: partial.sdkId, contextWindow: 128_000, reasoning: true, ...partial } as ModelSpec;
}

describe("effortLevels falls back to the contract vocab (uncurated reasoning models)", () => {
  test("o3 deployment with no curated efforts clamps to low/medium/high (not the full OpenAI superset)", () => {
    const o3 = spec({ provider: "azure-foundry", sdkId: "o3", canonicalId: "o3" });
    expect(effortLevels(o3)).toEqual(["low", "medium", "high"]);
    expect(effortLevels(o3)).not.toContain("xhigh");
    expect(effortLevels(o3)).not.toContain("minimal");
  });

  test("gpt-5.1-codex-max gets xhigh; base gpt-5 gets minimal", () => {
    expect(effortLevels(spec({ provider: "openai", sdkId: "gpt-5.1-codex-max" }))).toContain("xhigh");
    expect(effortLevels(spec({ provider: "openai", sdkId: "gpt-5" }))).toContain("minimal");
  });

  test("non-reasoning spec still gets nothing even if its family could reason", () => {
    const noReason = spec({ provider: "openai", sdkId: "o3", reasoning: false });
    expect(effortLevels(noReason)).toEqual([]);
  });
});

describe("reasoningOptions honors a forced effort", () => {
  test("gpt-5-pro is always high regardless of the requested level", () => {
    const pro = spec({ provider: "openai", sdkId: "gpt-5-pro" });
    expect(reasoningOptions(pro, "low")).toEqual({ openai: { reasoningEffort: "high" } });
    expect(reasoningOptions(pro, "medium")).toEqual({ openai: { reasoningEffort: "high" } });
  });
  test("o3-pro forced high too", () => {
    expect(reasoningOptions(spec({ provider: "azure", sdkId: "o3-pro" }), "low")).toEqual({ openai: { reasoningEffort: "high" } });
  });
});
