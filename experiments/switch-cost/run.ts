import { buildFixture } from "./fixture.ts";
import { renderAnthropic, renderOpenAI, renderGemini } from "./renderers.ts";
import { checkAnthropic, checkOpenAI, checkGemini, checkFidelity, type Check } from "./validate.ts";
import { payloadTokens, inputCostUSD } from "./cost.ts";
import { curate } from "./curate.ts";
import { buildScaled } from "./scale.ts";

const line = (n = 72) => console.log("─".repeat(n));
function printChecks(title: string, checks: Check[]) {
  console.log(`\n${title}`);
  for (const c of checks) console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.check}${c.detail ? `   [${c.detail}]` : ""}`);
  return checks.every((c) => c.pass);
}

const full = buildFixture();

// 1) RENDER to all three providers
const A = renderAnthropic(full), O = renderOpenAI(full), G = renderGemini(full);

console.log("EXPERIMENT 1 — canonical state → render per provider → switch at task boundary\n");
line();
console.log("PART A: rendering correctness (structural validity per provider)");

let allPass = true;
allPass = printChecks("Anthropic Messages API:", checkAnthropic(A)) && allPass;
allPass = printChecks("OpenAI Chat Completions:", checkOpenAI(O)) && allPass;
allPass = printChecks("Gemini generateContent:", checkGemini(G)) && allPass;

line();
console.log("PART B: cross-provider FIDELITY (same canonical state ⇒ identical semantics)");
allPass = printChecks("Fidelity:", checkFidelity(A, O, G)) && allPass;

// 2) SWITCH COST: full transcript vs curated projection
line();
console.log("PART C: task-boundary switch cost — carry FULL transcript vs CURATED ledger\n");

const cur = curate(full);
const rendererFor: Record<string, (s: any) => any> = {
  "claude-opus-4-8": renderAnthropic,
  "claude-sonnet-4-6": renderAnthropic,
  "gpt-5.4": renderOpenAI,
  "gemini-2.5-pro": renderGemini,
  "deepseek-v4-pro": renderOpenAI, // deepseek is OpenAI-compatible
};

const fullTokFor = (m: string) => payloadTokens(rendererFor[m](full));
const curTokFor = (m: string) => payloadTokens(rendererFor[m](cur));

console.log("  target model        full_tok  cur_tok   full_$     cur_$      saved");
for (const m of Object.keys(rendererFor)) {
  const ft = fullTokFor(m), ct = curTokFor(m);
  const fc = inputCostUSD(ft, m), cc = inputCostUSD(ct, m);
  const saved = ((1 - cc / fc) * 100).toFixed(0);
  console.log(
    `  ${m.padEnd(18)}  ${String(ft).padStart(7)}  ${String(ct).padStart(7)}   ` +
      `$${fc.toFixed(5)}  $${cc.toFixed(5)}   ${saved}%`,
  );
}

// SCALING: the real claim — curated is ~bounded, transcript is O(session length),
// so the switch-cost advantage GROWS with session length. Measure it.
console.log("\n  scaling (Anthropic render; switch cost = re-ingest at Sonnet $3/Mtok):");
console.log("  cycles   full_tok   cur_tok    ratio   full_$switch   cur_$switch");
let lastRatio = 1;
for (const cycles of [1, 4, 16, 64, 256]) {
  const s = buildScaled(cycles);
  const ft = payloadTokens(renderAnthropic(s));
  const ct = payloadTokens(renderAnthropic(curate(s)));
  lastRatio = ft / ct;
  const fc = inputCostUSD(ft, "claude-sonnet-4-6"), cc = inputCostUSD(ct, "claude-sonnet-4-6");
  console.log(
    `  ${String(cycles).padStart(6)}   ${String(ft).padStart(8)}   ${String(ct).padStart(7)}   ${lastRatio.toFixed(1).padStart(5)}×   ` +
      `$${fc.toFixed(4).padStart(8)}    $${cc.toFixed(4)}`,
  );
}
const ratio = lastRatio.toFixed(0);
console.log(`\n  curated context stays ~flat while the transcript grows linearly ⇒ at 256 cycles the`);
console.log(`  switch is ${ratio}× cheaper. Within a task you STAY WARM (cache hit ⇒ ~0 re-ingest);`);
console.log(`  the re-ingest cost is only paid AT a task-boundary switch, against a small projection.`);

// 3) POISONING RECOVERY: invalidated fact must be absent from the projection
line();
console.log("PART D: context-poisoning recovery (invalidate ⇒ gone from projection)");
const recap = (cur.turns[0] as any).text as string;
const poisoned = full.facts.find((f) => !f.valid)!;
const corrected = full.facts.find((f) => f.id === "f4")!;
const poisonGone = !recap.includes("bug is in parseToken");
const correctedKept = recap.includes("compares token.exp");
console.log(`  invalidated fact: "${poisoned.text}"`);
console.log(`  ${poisonGone ? "PASS" : "FAIL"}  poisoned fact ABSENT from curated projection`);
console.log(`  ${correctedKept ? "PASS" : "FAIL"}  corrected fact PRESENT in curated projection`);
allPass = allPass && poisonGone && correctedKept;

line();
console.log(`\nVERDICT: ${allPass ? "✅ structure HOLDS" : "❌ structure has FAILURES"} — ` +
  `one canonical state rendered valid+identical across 3 providers; ` +
  `task-boundary switch costs ~1/${ratio} of carrying the transcript; poisoning recoverable.`);
process.exit(allPass ? 0 : 1);
