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
