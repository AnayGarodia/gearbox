import { test, expect } from "bun:test";
import { capabilitiesFor, formatCapabilityMatrix, missingRequirements, supportsRequirements } from "../src/model/capabilities.ts";
import { findModel } from "../src/providers.ts";

test("capabilities distinguish normal tool turns from image turns", () => {
  const sonnet = findModel("claude-sonnet-4-6")!;
  const deepseek = findModel("deepseek-v4-pro")!;

  expect(supportsRequirements(sonnet, ["tools"])).toBe(true);
  expect(supportsRequirements(sonnet, ["tools", "images"])).toBe(true);
  expect(supportsRequirements(deepseek, ["tools"])).toBe(true);
  expect(supportsRequirements(deepseek, ["tools", "images"])).toBe(false);
  expect(missingRequirements(deepseek, ["tools", "images"])).toEqual(["images"]);
});

test("unknown capability support passes the requirements filter (optimistic)", () => {
  // Gateway / openai-compat / local providers report "unknown" for tools —
  // treating that as missing silently excluded every such model from routing
  // (every turn requires tools). Unknown passes; only explicit false excludes.
  const gateway = findModel("openrouter/anthropic/claude-sonnet-4.5") ?? {
    id: "openrouter/test",
    provider: "openrouter",
    sdkId: "test",
    label: "test",
    contextWindow: 128_000,
  };
  expect(supportsRequirements(gateway, ["tools"])).toBe(true);
  expect(missingRequirements(gateway, ["tools", "images", "jsonSchema"])).toEqual([]);
  // Explicit false is still a hard exclusion.
  const noTools = { ...gateway, id: "x/no-tools", capabilities: { tools: false as const } };
  expect(supportsRequirements(noTools, ["tools"])).toBe(false);
  expect(missingRequirements(noTools, ["tools"])).toEqual(["tools"]);
});

test("capability matrix is readable and marks unknown support explicitly", () => {
  const sonnet = findModel("claude-sonnet-4-6")!;
  const openrouter = findModel("openrouter/anthropic/claude-sonnet-4.5") ?? {
    id: "openrouter/test",
    provider: "openrouter",
    sdkId: "test",
    label: "test",
    contextWindow: 128_000,
  };
  const out = formatCapabilityMatrix([sonnet, openrouter]);
  expect(out).toContain("provider");
  expect(out).toContain("sonnet-4.6");
  expect(out).toContain("openrouter");
  expect(out).toContain("?");
});

test("capabilities expose exact usage for native profiled models", () => {
  const gpt = findModel("gpt-5.5")!;
  const caps = capabilitiesFor(gpt);
  expect(caps.usage).toBe("exact");
  expect(caps.reasoningEffort).toContain("high");
  expect(caps.pricing?.input).toBeGreaterThan(0);
});
