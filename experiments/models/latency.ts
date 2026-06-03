// MODEL DATA — measured latency: time-to-first-token (TTFT) and output tokens/sec,
// the inputs routing needs for latency-class decisions. Anthropic via streaming SSE;
// local qwen via ollama's reported timings. Real measurements, a few trials each.
// Run: bun run experiments/models/latency.ts
import { existsSync, readFileSync } from "node:fs";
const keys: Record<string, string> = { ...process.env } as any;
const envPath = `${import.meta.dir}/../.env.local`;
if (existsSync(envPath)) for (const l of readFileSync(envPath, "utf8").split("\n")) { const m = /^([A-Z0-9_]+)\s*=\s*(.+)$/.exec(l.trim()); if (m) keys[m[1]] = m[2]; }

const PROMPT = "Write a TypeScript function that debounces an async function, with types. Then explain it in 3 sentences.";

async function anthropic(model: string): Promise<{ ttft: number; tps: number } | null> {
  if (!keys.ANTHROPIC_API_KEY) return null;
  const t0 = performance.now();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": keys.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 400, stream: true, messages: [{ role: "user", content: PROMPT }] }),
  });
  let ttft = 0, out = 0;
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.startsWith("data: ")) continue;
      try {
        const j = JSON.parse(line.slice(6));
        if (j.type === "content_block_delta" && j.delta?.text) { if (!ttft) ttft = performance.now() - t0; }
        if (j.type === "message_delta" && j.usage?.output_tokens) out = j.usage.output_tokens;
      } catch { /* [DONE] etc */ }
    }
  }
  const total = performance.now() - t0;
  return { ttft, tps: out / ((total - ttft) / 1000) };
}

async function qwen(): Promise<{ ttft: number; tps: number } | null> {
  try {
    const res = await fetch("http://localhost:11434/api/generate", { method: "POST", body: JSON.stringify({ model: "qwen2.5-coder:7b", prompt: PROMPT, stream: false, options: { num_predict: 400 } }) });
    const j: any = await res.json();
    return { ttft: (j.prompt_eval_duration ?? 0) / 1e6, tps: j.eval_count / ((j.eval_duration ?? 1) / 1e9) }; // ns→ms, tok/s
  } catch { return null; }
}

const TRIALS = 3;
async function avg(fn: () => Promise<{ ttft: number; tps: number } | null>) {
  const rs = []; for (let i = 0; i < TRIALS; i++) { const r = await fn(); if (r) rs.push(r); }
  if (!rs.length) return null;
  return { ttft: rs.reduce((s, r) => s + r.ttft, 0) / rs.length, tps: rs.reduce((s, r) => s + r.tps, 0) / rs.length };
}

console.log("\nMODEL DATA · measured latency (TTFT + output tok/s, avg of 3)\n");
console.log("model                  TTFT(ms)   out tok/s");
console.log("──────────────────────────────────────────────");
for (const [label, fn] of [["claude-haiku-4-5", () => anthropic("claude-haiku-4-5")], ["claude-sonnet-4-6", () => anthropic("claude-sonnet-4-6")], ["qwen2.5-coder:7b (local)", qwen]] as const) {
  const r = await avg(fn as any);
  console.log(`${label.padEnd(24)} ${r ? r.ttft.toFixed(0).padStart(7) : "—".padStart(7)}   ${r ? r.tps.toFixed(1).padStart(8) : "—".padStart(8)}`);
}
console.log("");
