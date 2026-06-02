// Experiment 6 — does a SIMPLER alternative architecture work? (goal ii)
// We model three real architectures over an N-turn session WITH PROMPT CACHING
// (the thing that makes "just resend the transcript" viable), and find where each
// wins. Honest framing: the question isn't "is the ledger better" in the abstract,
// it's "when does the simpler structure suffice?"
//
// Architectures:
//   A) gateway-only / transcript-as-truth (OpenRouter/LiteLLM + thin agent):
//      state = full transcript in one format; resend every turn; pooled gateway credits.
//   B) pi-as-is: multi-provider, manual model pick, raw transcript per session, no curation.
//      (cost-identical to A for a given session; differs only in routing/credit, see matrix.)
//   C) gearbox: canonical ledger → bounded curated projection each turn.
//
// Cost model (Anthropic Sonnet-ish, USD per Mtok): full input 3.00, cache-read 0.30
// (10%), cache-write 3.75 (1.25x). A provider SWITCH makes the next turn cold
// (no cache on the new provider) → full re-ingest of the whole current context.

const FULL = 3.0, CACHE_READ = 0.30, CACHE_WRITE = 3.75;
const c = (tok: number, rate: number) => (tok / 1_000_000) * rate;

const N = 60;            // turns
const T = 1500;          // new tokens added per turn (user+assistant+tool result)
// transcript-as-truth context after k turns:
const fullCtx = (k: number) => k * T;
// gearbox curated projection after k turns (shape from Exp 1 real data: bounded growth)
const curatedCtx = (k: number) => 460 + 30 * k;

// cost of one turn given prior-context size, new tokens, and whether this turn is
// a COLD turn (just switched providers → whole context re-ingested at full price)
function turnCost(priorCtx: number, cold: boolean) {
  if (cold) return c(priorCtx + T, FULL);                 // cold: full re-ingest of everything
  return c(priorCtx, CACHE_READ) + c(T, CACHE_WRITE);     // warm: cached prefix + write new
}

// simulate a session with `switches` provider changes spread evenly
function sessionCost(ctxOf: (k: number) => number, switches: number) {
  const switchTurns = new Set<number>();
  for (let s = 1; s <= switches; s++) switchTurns.add(Math.floor((s * N) / (switches + 1)));
  let total = 0;
  for (let k = 1; k <= N; k++) total += turnCost(ctxOf(k - 1), switchTurns.has(k) || k === 1);
  return total;
}

console.log("EXPERIMENT 6 — does a simpler architecture suffice? (60-turn session, prompt caching modeled)\n");
console.log("Cumulative session cost vs number of provider switches:\n");
console.log("  switches   transcript-as-truth (A/B)   gearbox ledger (C)   ledger saves");
for (const sw of [0, 2, 5, 10, 20, 40]) {
  const a = sessionCost(fullCtx, sw);
  const g = sessionCost(curatedCtx, sw);
  const save = a > 0 ? ((1 - g / a) * 100).toFixed(0) : "0";
  console.log(`  ${String(sw).padStart(8)}   $${a.toFixed(4).padStart(10)}              $${g.toFixed(4).padStart(8)}         ${save.padStart(3)}%`);
}

console.log(`\nKey (honest reading of the numbers): even at 0 switches the ledger is ~68% cheaper —`);
console.log(`prompt caching does NOT make a big transcript free; you still pay cache-READ (~0.3/Mtok)`);
console.log(`on the full prior context every turn, and curation shrinks that base. The gap widens to`);
console.log(`92% at 40 switches (each switch cold-re-ingests the whole transcript vs a bounded projection).`);
console.log(`BUT absolute costs are modest ($0.36–$5.71 for a 60-turn session) — so for LIGHT, single-`);
console.log(`provider use the simpler structure is "good enough", and COST alone doesn't force the ledger.\n`);

// structural capability matrix — properties that cost can't capture (goal ii + iii)
console.log("Structural capability matrix (✓ native / ✗ not / ~ bolt-on):");
const rows = [
  ["requirement",                        "A: gateway-only", "B: pi-as-is", "C: gearbox"],
  ["cheap mid-workflow switching",       "✗ (cold resend)", "✗ (cold resend)", "✓ (bounded proj)"],
  ["marginal-benefit routing",           "~ (coarse auto)", "✗ (manual)",     "✓"],
  ["per-ACCOUNT credit routing",         "✗ (pooled)",      "~ (per key)",    "✓ (balances)"],
  ["context-poisoning recovery",         "✗ (transcript)",  "✗ (transcript)", "✓ (invalidate)"],
  ["shared multi-session memory",        "✗",               "✗",              "✓ (shared ledger)"],
  ["complexity to build",                "✓ low",           "✓ low",          "✗ high"],
];
for (const r of rows) console.log("  " + r[0].padEnd(34) + r[1].padEnd(18) + r[2].padEnd(16) + r[3]);

console.log(`\nVERDICT (ii): a simpler structure (gateway-only / pi-as-is) genuinely SUFFICES if you`);
console.log(`mostly stay on one provider, don't need credit-aware routing, poisoning recovery, or`);
console.log(`shared multi-session memory. The ledger is JUSTIFIED — not over-engineering — precisely`);
console.log(`for the workflow Gearbox targets: frequent intelligent switching + long sessions +`);
console.log(`many providers/accounts + parallel sessions. The structure should be EARNED by that need.`);
