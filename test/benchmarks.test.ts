// The real benchmark corpus + per-kind quality resolver (benchmarks.ts).
import { test, expect } from "bun:test";
import { qualityForKind, qualityNote, benchmarkRow } from "../src/model/benchmarks.ts";

test("code quality is SWE-bench-primary (not diluted by competitive-programming scores)", () => {
  // deepseek-v4-pro: SWE 0.736 is the primary signal; LiveCodeBench 0.568 must
  // NOT drag it down (a model strong at real PRs but weaker at LCB puzzles still
  // clears the bar). So code quality = SWE 0.736, not the mean with LCB.
  expect(qualityForKind("deepseek-v4-pro", "code")!).toBeCloseTo(0.736, 3);
  expect(qualityForKind("deepseek-v4-pro", "code")!).toBeGreaterThanOrEqual(0.7);
});

test("a coding-board-only model (no SWE) falls back to Aider/LiveCodeBench", () => {
  // llama-4-maverick has LiveCodeBench 0.434 (no SWE) → code uses the fallback.
  expect(qualityForKind("bedrock/meta.llama4-maverick-17b-instruct-v1:0", "code")!).toBeCloseTo(0.434, 3);
});

test("HEADLINE: Haiku 4.5's real SWE-bench (0.733) clears the 0.7 code bar — the seeded 0.38 guess wrongly excluded it", () => {
  expect(qualityForKind("claude-haiku-4-5", "code")!).toBeGreaterThanOrEqual(0.7);
});

test("plan quality uses GPQA + SWE (reasoning), distinct from code", () => {
  // opus: code=SWE 0.886; plan = mean(GPQA 0.936, SWE 0.886) = 0.911.
  expect(qualityForKind("claude-opus-4-8", "plan")!).toBeCloseTo((0.936 + 0.886) / 2, 3);
});

test("a composite-only model falls back to the normalized AA index (never blended with percentages)", () => {
  // grok-4.1-fast has only aaIndex 23.6 → 23.6/65 ≈ 0.363.
  expect(qualityForKind("grok-4.1-fast", "code")!).toBeCloseTo(23.6 / 65, 3);
});

test("weak models stay below the code bar on real data", () => {
  expect(qualityForKind("bedrock/amazon.nova-pro-v1:0", "code")!).toBeLessThan(0.7);
  expect(qualityForKind("gemini-3.1-flash-lite", "code")!).toBeLessThan(0.7);
});

test("bedrock/vertex mirrors resolve to the canonical model's real scores", () => {
  expect(qualityForKind("bedrock/anthropic.claude-haiku-4-5-20251001-v1:0", "code"))
    .toBe(qualityForKind("claude-haiku-4-5", "code"));
  expect(qualityForKind("vertex/gemini-3.5-flash", "code"))
    .toBe(qualityForKind("gemini-3.5-flash", "code"));
});

test("an unknown / long-tail model returns null (caller falls back to profile/family/flywheel)", () => {
  expect(qualityForKind("some-obscure-openrouter-model", "code")).toBeNull();
  expect(benchmarkRow("some-obscure-openrouter-model")).toBeUndefined();
});

test("qualityNote names the contributing benchmarks + provenance for /why", () => {
  const note = qualityNote("claude-opus-4-8", "code")!;
  expect(note).toContain("SWE");
  expect(note).toContain("researched");
});
