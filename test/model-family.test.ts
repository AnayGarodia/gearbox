import { test, expect } from "bun:test";
import { modelFamily, candidateModelsFor } from "../src/model/family.ts";
import { findModel } from "../src/providers.ts";

test("collapses provider-specific ids to a shared family", () => {
  expect(modelFamily("claude-sonnet-4-6")).toBe("claude-sonnet-4");
  expect(modelFamily("bedrock/anthropic.claude-sonnet-4-20250514-v1:0")).toBe("claude-sonnet-4");
  expect(modelFamily("claude-opus-4-8")).toBe("claude-opus-4");
  expect(modelFamily("bedrock/anthropic.claude-opus-4-20250514-v1:0")).toBe("claude-opus-4");
});

test("gemini across direct + vertex", () => {
  expect(modelFamily("gemini-3.5-flash")).toBe("gemini-3.5-flash");
  expect(modelFamily("vertex/gemini-3.5-flash")).toBe("gemini-3.5-flash");
});

test("unknown ids fall back to themselves", () => {
  expect(modelFamily("deepseek-v4-pro")).toBe("deepseek-v4-pro");
});

// ── candidateModelsFor ────────────────────────────────────────────────────────

test("candidateModelsFor sonnet includes anthropic and bedrock variants", () => {
  const spec = findModel("claude-sonnet-4-6")!;
  const candidates = candidateModelsFor(spec);

  // Must include at least the anthropic + bedrock entries
  expect(candidates.length).toBeGreaterThanOrEqual(2);

  const ids = candidates.map((m) => m.id);
  expect(ids).toContain("claude-sonnet-4-6");
  expect(ids).toContain("bedrock/anthropic.claude-sonnet-4-20250514-v1:0");

  // All candidates belong to the same family
  for (const m of candidates) {
    expect(modelFamily(m.id)).toBe("claude-sonnet-4");
  }
});

test("candidateModelsFor is symmetric: bedrock sonnet returns the same family members as anthropic sonnet", () => {
  const anthropicSpec = findModel("claude-sonnet-4-6")!;
  const bedrockSpec = findModel("bedrock/anthropic.claude-sonnet-4-20250514-v1:0")!;

  const fromAnthropic = candidateModelsFor(anthropicSpec).map((m) => m.id).sort();
  const fromBedrock = candidateModelsFor(bedrockSpec).map((m) => m.id).sort();

  expect(fromBedrock).toEqual(fromAnthropic);
});

test("candidateModelsFor gemini includes both google and vertex variants", () => {
  const spec = findModel("gemini-3.5-flash")!;
  const candidates = candidateModelsFor(spec);

  const ids = candidates.map((m) => m.id);
  expect(ids).toContain("gemini-3.5-flash");
  expect(ids).toContain("vertex/gemini-3.5-flash");

  // All candidates belong to the same family
  for (const m of candidates) {
    expect(modelFamily(m.id)).toBe("gemini-3.5-flash");
  }
});

test("candidateModelsFor returns only the single model for a unique family", () => {
  const spec = findModel("deepseek-v4-pro")!;
  const candidates = candidateModelsFor(spec);

  expect(candidates).toHaveLength(1);
  expect(candidates[0]!.id).toBe("deepseek-v4-pro");
});

test("every result of candidateModelsFor shares the same modelFamily string", () => {
  // Verify the invariant across a sample of known multi-provider models
  for (const id of [
    "claude-sonnet-4-6",
    "bedrock/anthropic.claude-sonnet-4-20250514-v1:0",
    "claude-opus-4-8",
    "bedrock/anthropic.claude-opus-4-20250514-v1:0",
    "gemini-3.5-flash",
    "vertex/gemini-3.5-flash",
    "deepseek-v4-pro",
  ]) {
    const spec = findModel(id)!;
    const expectedFamily = modelFamily(id);
    const candidates = candidateModelsFor(spec);

    expect(candidates.length).toBeGreaterThanOrEqual(1);
    for (const m of candidates) {
      expect(modelFamily(m.id)).toBe(expectedFamily);
    }
  }
});
