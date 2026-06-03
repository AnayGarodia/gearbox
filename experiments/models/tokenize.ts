// MODEL DATA — real tokenization across models. Replaces the chars/4 guess with
// measured truth: Anthropic /v1/messages/count_tokens (exact Claude tokens, free),
// js-tiktoken o200k (OpenAI/GPT family), and ollama prompt_eval_count (the local
// model's real count). Quantifies how wrong chars/4 and a single-tokenizer proxy
// are per content type → tells us what to actually use for budgeting.
// Run: bun run experiments/models/tokenize.ts
import { existsSync, readFileSync } from "node:fs";
import { countTokens as tiktokenO200k } from "../switch-cost/cost.ts";

const keys: Record<string, string> = { ...process.env } as any;
const envPath = `${import.meta.dir}/../.env.local`;
if (existsSync(envPath)) for (const l of readFileSync(envPath, "utf8").split("\n")) { const m = /^([A-Z0-9_]+)\s*=\s*(.+)$/.exec(l.trim()); if (m) keys[m[1]] = m[2]; }

const root = `${import.meta.dir}/../..`;
const rd = (f: string) => readFileSync(`${root}/${f}`, "utf8");

const samples: { name: string; text: string }[] = [
  { name: "TS code", text: rd("src/ui/App.tsx").slice(0, 6000) },
  { name: "prose", text: rd("DESIGN.md").slice(0, 6000) },
  { name: "tool output", text: ("PASS src/x.test.ts\n  ✓ does a thing (3ms)\nfile.ts:42:  const x = compute(token, { retries: 3 })\n").repeat(40) },
  { name: "JSON", text: JSON.stringify({ models: Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, ctx: 200000, cost: 3.0, tags: ["code", "fast"] })) }) },
];

async function claudeCount(text: string): Promise<number | null> {
  if (!keys.ANTHROPIC_API_KEY) return null;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
      method: "POST",
      headers: { "x-api-key": keys.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5", messages: [{ role: "user", content: text }] }),
    });
    const j: any = await r.json();
    return j?.input_tokens ?? null;
  } catch {
    return null;
  }
}

async function qwenCount(text: string): Promise<number | null> {
  try {
    const r = await fetch("http://localhost:11434/api/generate", { method: "POST", body: JSON.stringify({ model: "qwen2.5-coder:7b", prompt: text, stream: false, options: { num_predict: 1 } }) });
    const j: any = await r.json();
    return j?.prompt_eval_count ?? null; // ollama reports the real prompt token count
  } catch {
    return null;
  }
}

const pct = (est: number, real: number | null) => (real ? `${(((est - real) / real) * 100 >= 0 ? "+" : "")}${(((est - real) / real) * 100).toFixed(0)}%` : "—");

console.log("\nMODEL DATA · real tokenization vs estimates\n");
console.log("sample        chars  chars/4   tiktoken   Claude(real)  qwen(real) │ chars/4 err vs Claude  tiktoken err");
console.log("──────────────────────────────────────────────────────────────────┼─────────────────────────────────────");
for (const s of samples) {
  const c = s.text.length;
  const div4 = Math.ceil(c / 4);
  const tk = tiktokenO200k(s.text);
  const cl = await claudeCount(s.text);
  const qw = await qwenCount(s.text);
  console.log(
    `${s.name.padEnd(12)} ${String(c).padStart(5)} ${String(div4).padStart(7)} ${String(tk).padStart(9)} ${String(cl ?? "—").padStart(11)} ${String(qw ?? "—").padStart(10)}  │  ${pct(div4, cl).padStart(8)}            ${pct(tk, cl).padStart(8)}`,
  );
}
console.log("\nchars/cap per real token (Claude):");
for (const s of samples) { const cl = await claudeCount(s.text); if (cl) console.log(`  ${s.name.padEnd(12)} ${(s.text.length / cl).toFixed(2)} chars/token`); }
console.log("");
