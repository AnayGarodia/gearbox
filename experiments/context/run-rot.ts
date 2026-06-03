// E-B2 — Context rot under SUPERSEDED facts + distractors (the fair, hard test).
// A value is stated early (stale), CORRECTED mid-session, amid many numeric
// distractors. Designs:
//   D0 raw      — full transcript: stale value + correction + all distractors
//   D3 curated  — core memory holds ONLY the current fact (stale invalidated/dropped)
//                 + recent distractors. Models the harness extracting + invalidating.
// Hypothesis: as length/distractors grow, D0 confuses the stale vs current value;
// D3 stays correct. Many trials → accuracy %. Local qwen (free) primary; --haiku adds
// a paid confirm. Run: bun run experiments/context/run-rot.ts [--haiku] [trials]
import { existsSync, readFileSync } from "node:fs";

const keys: Record<string, string> = { ...process.env } as any;
const envPath = `${import.meta.dir}/../.env.local`;
if (existsSync(envPath)) for (const l of readFileSync(envPath, "utf8").split("\n")) { const m = /^([A-Z0-9_]+)\s*=\s*(.+)$/.exec(l.trim()); if (m) keys[m[1]] = m[2]; }

const TRIALS = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 6);
const USE_HAIKU = process.argv.includes("--haiku");

// distractor pool — lots of "X is N" config facts to compete for attention
const POOL = [
  "retry count is 3", "cache TTL is 60 seconds", "max upload is 25 MB", "the worker pool has 8 threads",
  "rate limit is 100 req/min", "the queue holds 512 jobs", "log level is warn", "session timeout is 30 minutes",
  "the CDN edge count is 14", "build timeout is 600 seconds", "default page size is 50", "JWT audience is api.gearbox",
  "the heartbeat interval is 5 seconds", "max retries on 5xx is 4", "the read buffer is 64 KB", "WAL checkpoint every 1000 pages",
];
const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
function shuffle<T>(a: T[], r: () => number) { const x = a.slice(); for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [x[i], x[j]] = [x[j]!, x[i]!]; } return x; }

const STALE = "the deploy token rotates every 24 hours";
const CURRENT_VAL = "90 minutes";
const QUESTION = "Exactly how often does the deploy token rotate right now? Answer in a few words.";
const correct = (s: string) => /\b90\b|ninety/i.test(s) && !/24|hour/i.test(s);

function scenario(nDistract: number, trial: number) {
  const r = rng(trial * 7919 + nDistract);
  const fillers = Array.from({ length: nDistract }, (_, i) => `Turn ${i}: noted that ${shuffle(POOL, () => r())[i % POOL.length]}. Reviewed the module and continued.`);
  const mid = Math.floor(fillers.length * 0.55);
  // D0 raw: stale stated early, corrected mid, distractors throughout
  const d0Lines = [`Turn 0: ${STALE}.`, ...fillers.slice(0, mid), `Correction: the deploy token now rotates every ${CURRENT_VAL} (the 24-hour figure is outdated).`, ...fillers.slice(mid)];
  const d0 = { system: "You are a coding agent. Use the conversation to answer precisely.", user: d0Lines.join("\n") + "\n\n" + QUESTION };
  // D3 curated: core memory = current fact only; recent distractors; no stale, no correction needed
  const d3 = { system: `You are a coding agent.\nCURRENT FACTS (authoritative):\n- the deploy token rotates every ${CURRENT_VAL}.`, user: fillers.slice(-12).join("\n") + "\n\n" + QUESTION };
  return { d0, d3 };
}

async function qwen(system: string, user: string): Promise<string> {
  const body = JSON.stringify({ model: "qwen2.5-coder:7b", prompt: `${system}\n\n${user}`, stream: false, options: { temperature: 0, num_predict: 40 } });
  const res = await fetch("http://localhost:11434/api/generate", { method: "POST", body });
  return ((await res.json()) as any).response?.trim() ?? "";
}
async function haiku(system: string, user: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": keys.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 40, system, messages: [{ role: "user", content: user }] }) });
  const j: any = await res.json();
  return (j?.content?.[0]?.text ?? "").trim();
}

async function evalDesign(ask: (s: string, u: string) => Promise<string>, key: "d0" | "d3", nDistract: number) {
  let ok = 0;
  for (let t = 0; t < TRIALS; t++) {
    const sc = scenario(nDistract, t);
    const ans = await ask(sc[key].system, sc[key].user);
    if (correct(ans)) ok++;
  }
  return ok / TRIALS;
}

async function backend(name: string, ask: (s: string, u: string) => Promise<string>, scales: number[]) {
  console.log(`\n${name} — accuracy recalling the CURRENT value (correct = "90 minutes", not "24 hours"), ${TRIALS} trials:`);
  console.log("distractors │  D0 raw   D3 curated");
  for (const n of scales) {
    const d0 = await evalDesign(ask, "d0", n);
    const d3 = await evalDesign(ask, "d3", n);
    console.log(`${String(n).padStart(10)} │  ${(d0 * 100).toFixed(0).padStart(4)}%     ${(d3 * 100).toFixed(0).padStart(4)}%`);
  }
}

console.log("\nE-B2 · superseded-fact recall under distractors (does curation+invalidation beat raw?)");
await backend("qwen2.5-coder:7b (local, free)", qwen, [20, 80, 200]);
if (USE_HAIKU && keys.ANTHROPIC_API_KEY) await backend("claude-haiku-4-5 (paid)", haiku, [40, 200]);
console.log("\nHypothesis: D0 accuracy drops with distractors (stale value competes); D3 holds.\n");
