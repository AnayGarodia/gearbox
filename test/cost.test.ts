import { test, expect } from "bun:test";
import { estimateCost } from "../src/providers.ts";

test("estimateCost sums per-turn cost from each turn's model + tokens", () => {
  const turns = [
    { model: "claude-sonnet-4-6", inputTokens: 1_000_000, outputTokens: 1_000_000 }, // $3 + $15
    { model: "claude-haiku-4-5", inputTokens: 1_000_000, outputTokens: 0 }, // $1.00
  ];
  expect(estimateCost(turns)).toBeCloseTo(19.0, 5);
});

test("estimateCost ignores unknown models and zero turns", () => {
  expect(estimateCost([])).toBe(0);
  expect(estimateCost([{ model: "mystery", inputTokens: 1e6, outputTokens: 1e6 }])).toBe(0);
});

test("estimateCost prices cache tokens: reads ≈10% of input, writes ≈125%", () => {
  // haiku in = $1/Mtok. 1M cache reads → $0.10; 1M cache writes → $1.25.
  expect(estimateCost([{ model: "claude-haiku-4-5", inputTokens: 0, outputTokens: 0, cachedInputTokens: 1_000_000 }])).toBeCloseTo(0.1, 5);
  expect(estimateCost([{ model: "claude-haiku-4-5", inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 1_000_000 }])).toBeCloseTo(1.25, 5);
  // combined: 1M fresh ($1) + 1M read ($0.10) + 1M write ($1.25) = $2.35
  expect(estimateCost([{ model: "claude-haiku-4-5", inputTokens: 1e6, outputTokens: 0, cachedInputTokens: 1e6, cacheCreationInputTokens: 1e6 }])).toBeCloseTo(2.35, 5);
});

test("estimateCost charges $0 for flat-rate subscription seats (cli: ids)", () => {
  expect(estimateCost([{ model: "cli:claude-cli:claude-opus-4-8", inputTokens: 5e6, outputTokens: 5e6 }])).toBe(0);
});
