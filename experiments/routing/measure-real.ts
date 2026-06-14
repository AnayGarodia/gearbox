// Measure the keyword judge on REAL prompts (extract-prompts.ts output).
// No ground-truth labels, so this reports the two things labels aren't needed
// for: (1) the CONFIDENT-handle rate — how many real prompts the free keyword
// judge decides itself vs escalates to the LLM ladder — and (2) an AUDIT of
// what landed in the cheap tiers, where a hidden hard task would be a dangerous
// misroute. The cheapest buckets (summarize/classify/search, bar 0–0.2) are
// printed in full; chat (bar 0.3) is sampled — scan these for hard tasks.
//
// Run: bun run experiments/routing/measure-real.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classify, confidentKeywordKind } from "../../src/model/router.ts";

type Kind = "summarize" | "classify" | "search" | "chat" | "plan" | "code";
const prompts = readFileSync(join(import.meta.dir, "real-prompts.local.txt"), "utf8").split("\n").filter(Boolean);

const counts: Record<Kind, number> = { summarize: 0, classify: 0, search: 0, chat: 0, plan: 0, code: 0 };
const cheap: Record<string, string[]> = { summarize: [], classify: [], search: [], chat: [] };
let confident = 0;

for (const p of prompts) {
  const k = classify(p) as Kind;
  counts[k]++;
  if (confidentKeywordKind(p) != null) confident++;
  if (k in cheap) cheap[k]!.push(p);
}

const n = prompts.length;
const pct = (x: number) => `${((100 * x) / n).toFixed(1)}%`;
console.log(`=== keyword judge on ${n} REAL prompts ===`);
console.log(`confident (no LLM hop):  ${confident}  (${pct(confident)})`);
console.log(`escalate (→ LLM ladder): ${n - confident}  (${pct(n - confident)})`);
console.log(`\nkind distribution:`);
for (const k of Object.keys(counts) as Kind[]) console.log(`  ${k.padEnd(10)} ${counts[k]}  (${pct(counts[k])})`);

for (const k of ["search", "classify", "summarize"] as const) {
  console.log(`\n=== ALL routed to '${k}' (bar ${k === "search" ? 0.2 : 0}) — any hard task here is dangerous ===`);
  for (const p of cheap[k]!) console.log(`  ${p.slice(0, 120)}`);
}

console.log(`\n=== sample routed to 'chat' (bar 0.3) — scan for hidden code/plan ===`);
const c = cheap.chat!;
const step = Math.max(1, Math.floor(c.length / 90));
for (let i = 0; i < c.length; i += step) console.log(`  ${c[i]!.slice(0, 120)}`);
