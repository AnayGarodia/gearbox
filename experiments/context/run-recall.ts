// E-B — Context rot / recall fidelity (LIVE; needs ANTHROPIC_API_KEY).
// Buries one load-bearing fact, then asks about it under two designs:
//   D0 raw  — the fact stated once early, then a long noisy transcript after it
//   D3 core — a short recent context + the fact in an always-on core-memory block
// Hypothesis: as raw length grows, D0 recall degrades while D3 stays correct.
// Reads the key from env or experiments/.env.local; never prints it. ~cents (haiku).
// Run: ANTHROPIC_API_KEY=… bun run experiments/context/run-recall.ts
import { existsSync, readFileSync } from "node:fs";

const keys: Record<string, string> = { ...process.env } as any;
const envPath = `${import.meta.dir}/../.env.local`;
if (existsSync(envPath))
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)\s*=\s*(.+)$/.exec(line.trim());
    if (m) keys[m[1]] = m[2];
  }
const KEY = keys.ANTHROPIC_API_KEY;
if (!KEY) {
  console.log("\nE-B recall — set ANTHROPIC_API_KEY (or experiments/.env.local) to run this live.\n");
  process.exit(0);
}

const FACT = "The deploy token rotates every 90 minutes (NOT every 24 hours).";
const QUESTION = "How often does the deploy token rotate? Answer in a few words.";
const noise = (i: number) =>
  `Turn ${i}: read src/${["router", "auth", "cache", "tools"][i % 4]}.ts; adjusted handling; ran tests — green. ${"Reviewed the integration points and confirmed nothing else needed changing. ".repeat(3)}`;

async function ask(system: string, user: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 60, system, messages: [{ role: "user", content: user }] }),
  });
  const j: any = await res.json();
  return (j?.content?.[0]?.text ?? JSON.stringify(j)).trim();
}

const correct = (s: string) => /90\s*min|90-min|ninety/i.test(s);

console.log("\nE-B · recall fidelity: can the model recall a fact buried in a long session?\n");
for (const n of [4, 40, 120]) {
  const transcript = [FACT, ...Array.from({ length: n }, (_, i) => noise(i))].join("\n");
  // D0: fact early, buried under n noisy turns, all in the user message
  const d0 = await ask("You are a coding agent.", `${transcript}\n\n${QUESTION}`);
  // D3: noisy turns only in context, the fact lifted into core memory (system)
  const d3 = await ask(`You are a coding agent.\nPROJECT FACTS:\n- ${FACT}`, `${Array.from({ length: n }, (_, i) => noise(i)).join("\n")}\n\n${QUESTION}`);
  console.log(`noise=${String(n).padStart(3)} turns │ D0 raw: ${correct(d0) ? "✓" : "✗"} "${d0.slice(0, 50)}" │ D3 core: ${correct(d3) ? "✓" : "✗"} "${d3.slice(0, 50)}"`);
}
console.log("\n(✓ = recalled '90 minutes'. Expect D0 to degrade with noise; D3 to hold.)\n");
