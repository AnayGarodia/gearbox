// E-A — Cost/size of context designs across a growing coding session.
// Empirical token counts (js-tiktoken o200k_base, via ../switch-cost/cost.ts) on
// realistically-sized, generated session content. Compares the working set each
// turn for D0 raw / D1 recency / D2 recency+offload (tool-result clearing +
// fact-keep) / D3 (+small core memory). Reports per-turn input tokens, cumulative
// $ (sonnet input price), and the cold re-ingest $ to switch model at that turn.
// Run: bun run experiments/context/run-cost.ts
import { countTokens, inputCostUSD } from "../switch-cost/cost.ts";

// ── a realistic coding turn ──
type Turn = { user: string; assistantFact: string; assistantBody: string; toolOutput: string };

// Generated content sized like real coding turns. Tool output dominates (file
// reads, test runs) — that's the bulk that curation removes.
const CODE_BLOCK = `export function handleRequest(req: Request): Response {\n  const url = new URL(req.url);\n  const route = router.match(url.pathname);\n  if (!route) return new Response("not found", { status: 404 });\n  const ctx = buildContext(req, route);\n  return route.handler(ctx);\n}\n`.repeat(18); // ~a medium file read
const TEST_OUTPUT = `PASS  src/router.test.ts (12 tests)\nPASS  src/context.test.ts (8 tests)\nFAIL  src/auth.test.ts\n  ✕ rejects expired tokens (expiry compared in seconds not ms)\n`.repeat(6);

function makeTurn(i: number): Turn {
  return {
    user: `Turn ${i}: please look at the ${["router", "auth", "context", "tools", "session"][i % 5]} module and adjust the ${["timeout", "retry", "cache", "limit", "header"][i % 5]} handling, then run the tests.`,
    assistantBody:
      `I'll read the relevant file, find where the ${["timeout", "retry", "cache", "limit", "header"][i % 5]} is handled, make the smallest change, and run the suite to verify. Let me start by reading the module to understand the current structure and how it integrates with the rest of the system before editing anything.`,
    // the durable conclusion of the turn — what curation keeps
    assistantFact: `Turn ${i}: changed ${["router", "auth", "context", "tools", "session"][i % 5]} ${["timeout", "retry", "cache", "limit", "header"][i % 5]} handling; tests green.`,
    // the bulky tool output — what curation/offload removes for older turns
    toolOutput: i % 2 === 0 ? CODE_BLOCK : TEST_OUTPUT,
  };
}

// token cost of a single turn's parts
const turnTokens = (t: Turn) => ({
  user: countTokens(t.user),
  body: countTokens(t.assistantBody),
  fact: countTokens(t.assistantFact),
  tool: countTokens(t.toolOutput),
});

const SYSTEM = countTokens("You are Gearbox, a precise terminal coding agent. ".repeat(8)); // ~system+tools schema
const CORE_MEMORY = countTokens(
  "PROJECT FACTS:\n- runtime Bun, UI Ink. routing seam = ModelSelector. tools cwd-scoped.\n- auth expiry compared in seconds, must be ms.\n- tests: bun test. style: smallest change.\n".repeat(2),
); // a compact, bounded core-memory block
const RECENCY_K = 3; // keep the last K turns raw (Manus: recent stays verbatim)

// working-set input tokens for each design at turn t (0-indexed, inclusive)
function workingSet(turns: Turn[], t: number) {
  const tk = turns.slice(0, t + 1).map(turnTokens);
  const full = (x: ReturnType<typeof turnTokens>) => x.user + x.body + x.tool;
  const curatedOld = (x: ReturnType<typeof turnTokens>) => x.user + x.fact; // offload tool output + drop reasoning body, keep the fact
  const recentIdx = Math.max(0, t - RECENCY_K + 1);

  const d0 = SYSTEM + tk.reduce((s, x) => s + full(x), 0);
  const d1 = SYSTEM + tk.slice(recentIdx).reduce((s, x) => s + full(x), 0);
  const d2base = tk.slice(0, recentIdx).reduce((s, x) => s + curatedOld(x), 0) + tk.slice(recentIdx).reduce((s, x) => s + full(x), 0);
  const d2 = SYSTEM + d2base;
  const d3 = SYSTEM + CORE_MEMORY + d2base;
  return { d0, d1, d2, d3 };
}

const MODEL = "claude-sonnet-4-6";
const WINDOW = 200_000;

console.log("\nE-A · context-design cost across a growing coding session (real token counts)\n");
console.log("design       legend");
console.log("  D0 raw      full transcript (today's behavior)");
console.log("  D1 recency  last 3 turns only");
console.log("  D2 curated  recent raw + older turns offloaded to facts (tool-result clearing)");
console.log("  D3 +core    D2 + a small always-on project-memory block\n");
console.log("turns │   D0 raw    D1 rec   D2 cur   D3+core │  $/turn D0  $/turn D2 │ D0 % of 200k window");
console.log("──────┼──────────────────────────────────────┼────────────────────────┼────────────────────");

const lengths = [4, 8, 16, 32, 64, 128];
let maxTurns = Math.max(...lengths);
const turns = Array.from({ length: maxTurns }, (_, i) => makeTurn(i));
for (const n of lengths) {
  const ws = workingSet(turns, n - 1);
  const c0 = inputCostUSD(ws.d0, MODEL);
  const c2 = inputCostUSD(ws.d2, MODEL);
  const pct = ((ws.d0 / WINDOW) * 100).toFixed(0);
  const f = (x: number) => x.toLocaleString().padStart(8);
  console.log(
    `${String(n).padStart(5)} │ ${f(ws.d0)} ${f(ws.d1)} ${f(ws.d2)} ${f(ws.d3)} │  $${c0.toFixed(4)}   $${c2.toFixed(4)}  │ ${pct.padStart(4)}%${Number(pct) >= 100 ? "  ⚠ OVERFLOWS" : ""}`,
  );
}

// switch-cost: cold re-ingest of the working set on a fresh model at turn N
console.log("\nswitch-cost (cold re-ingest $ to hand the turn-64 context to a fresh model):");
const at = workingSet(turns, 63);
console.log(`  D0 raw   : $${inputCostUSD(at.d0, MODEL).toFixed(4)}  (${at.d0.toLocaleString()} tok)`);
console.log(`  D2 curated: $${inputCostUSD(at.d2, MODEL).toFixed(4)}  (${at.d2.toLocaleString()} tok)  → ${(at.d0 / at.d2).toFixed(1)}× cheaper`);
console.log("");
