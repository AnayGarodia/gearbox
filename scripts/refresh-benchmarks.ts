#!/usr/bin/env bun
// Benchmark-corpus refresh helper (user ask #2: keep the model scores fresh).
//
// The scores in src/model/benchmarks.ts are pulled from public leaderboards and
// go STALE as models update. This script does NOT auto-edit the corpus (the
// numbers must be read off real leaderboard pages, with a source URL each — never
// fabricated). It REPORTS what needs attention so a human (or an agent with web
// access) can re-research the flagged rows and edit benchmarks.ts:
//
//   • STALE rows   — older than STALENESS_MONTHS as of today; re-pull + bump asOf.
//   • UNCOVERED    — routable models with no benchmark row (a new flagship to add,
//                    or expected long-tail with no public scores).
//   • the SOURCES  — the leaderboard URLs to re-fetch, grouped.
//
// Run: bun run scripts/refresh-benchmarks.ts
import { allBenchmarks, staleBenchmarks, uncoveredModels, STALENESS_MONTHS } from "../src/model/benchmarks.ts";
import { modelRegistry } from "../src/providers.ts";

const now = Date.now();
const nowStr = new Date(now).toISOString().slice(0, 10);
const rows = allBenchmarks();

console.log(`Benchmark corpus — ${rows.length} rows · refresh horizon ${STALENESS_MONTHS} months · today ${nowStr}\n`);

const stale = staleBenchmarks(now);
if (stale.length) {
  console.log(`STALE (${stale.length}) — re-pull from the leaderboards and bump asOf:`);
  for (const s of stale) console.log(`  ${s.id.padEnd(34)} asOf ${s.asOf}  (${s.months} months old)`);
} else {
  console.log(`STALE: none — every row is within ${STALENESS_MONTHS} months.`);
}
console.log("");

const routable = modelRegistry().filter((m) => m.routable !== false).map((m) => m.id);
const uncovered = uncoveredModels(routable);
console.log(`UNCOVERED routable models (${uncovered.length}/${routable.length}) — add a row if a flagship, else expected long-tail (no public scores → floors out of code/plan):`);
for (const id of uncovered) console.log(`  ${id}`);
console.log("");

// The source URLs to re-fetch, de-duplicated.
const urls = new Set<string>();
for (const [, r] of rows) for (const u of r.srcUrls) urls.add(u);
console.log(`SOURCES to re-fetch (${urls.size}):`);
for (const u of [...urls].sort()) console.log(`  ${u}`);
console.log(`\nAfter re-researching: edit src/model/benchmarks.ts (numbers + bump asOf + keep a source URL each), then \`bun test test/benchmarks-freshness.test.ts\`.`);
