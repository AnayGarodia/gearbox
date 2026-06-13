// Guards the benchmark corpus against rot (user ask #2): flags a number that is
// "still-a-guess" (bad provenance / unsourced / malformed date) or STALE, and
// flags a mainstream routable model that has NO benchmark coverage.
import { test, expect } from "bun:test";
import { allBenchmarks, benchmarkRow, staleBenchmarks, uncoveredModels, STALENESS_MONTHS } from "../src/model/benchmarks.ts";
import { modelRegistry } from "../src/providers.ts";

test("every benchmark row is RESEARCHED, sourced, and has a valid YYYY-MM date (no fabricated/unsourced numbers)", () => {
  const bad: string[] = [];
  for (const [id, r] of allBenchmarks()) {
    if (r.src !== "researched") bad.push(`${id}: src is "${r.src}", not researched`);
    if (!r.srcUrls?.length) bad.push(`${id}: no source URL`);
    if (!/^\d{4}-\d{2}$/.test(r.asOf)) bad.push(`${id}: bad asOf "${r.asOf}"`);
    // a row with no actual metric is dead weight
    const hasMetric = r.sweVerified ?? r.aiderPolyglot ?? r.liveCodeBench ?? r.gpqaDiamond ?? r.aaIndex;
    if (hasMetric == null) bad.push(`${id}: no metric values`);
  }
  expect(bad).toEqual([]);
});

test("the mainstream routable models all have benchmark coverage (new flagship models must get a row)", () => {
  // The models people actually route to. The long-tail (ollama/groq/together/…)
  // legitimately has no public benchmarks and falls back/floors out; this only
  // asserts the flagships are covered so a NEW flagship can't slip in unscored.
  const mainstream = [
    "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5",
    "gpt-5.5", "gemini-3.1-pro-preview", "gemini-3.5-flash",
    "deepseek-v4-pro", "deepseek-v4-flash", "xai/grok-4.3",
  ];
  const missing = uncoveredModels(mainstream);
  expect(missing).toEqual([]);
});

test("STALENESS: no row is past the refresh horizon as of its own snapshot (bump asOf when re-researching)", () => {
  // Deterministic: check staleness as of the corpus's NEWEST snapshot, so this
  // fails only if a row was left behind when others were refreshed — not on a
  // calendar date (the refresh SCRIPT does the live-time report).
  const newest = allBenchmarks().map(([, r]) => r.asOf).sort().at(-1)!;
  const [y, m] = newest.split("-").map(Number);
  const asOfNewestMs = Date.UTC(y!, m! - 1, 1);
  expect(staleBenchmarks(asOfNewestMs)).toEqual([]);
  expect(STALENESS_MONTHS).toBeGreaterThan(0);
});

test("benchmarkRow resolves provider-prefixed registry ids via aliases (xai/grok-4.3 → grok-4.3)", () => {
  expect(benchmarkRow("xai/grok-4.3")).toBeTruthy();
  expect(benchmarkRow("google/gemini-3.1-flash-lite")).toBeTruthy();
  // sanity: this id is genuinely absent (long-tail), so coverage logic is real
  expect(modelRegistry().some((m) => m.id === "ollama/llama3.3")).toBe(true);
  expect(benchmarkRow("ollama/llama3.3")).toBeUndefined();
});
