// DECISIVE TEST (needs a key): POST a curated, rendered payload to each REAL
// provider API. Confirms (a) the payload is ACCEPTED (200) — not just shaped right
// per our own validator — and (b) the model continues the task coherently after a
// cross-vendor handoff. Reads keys from env or experiments/.env.local. NEVER prints
// keys (Gemini's key goes in the query string, so its URL is never logged).
import { buildFixture } from "../switch-cost/fixture.ts";
import { curate } from "../switch-cost/curate.ts";
import { renderAnthropic, renderOpenAI, renderGemini } from "../switch-cost/renderers.ts";
import { existsSync, readFileSync } from "node:fs";

// load .env.local (KEY=VALUE lines) without echoing values
const envPath = `${import.meta.dir}/../.env.local`;
const keys: Record<string, string> = { ...process.env } as any;
if (existsSync(envPath))
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)\s*=\s*(.+)$/.exec(line.trim());
    if (m) keys[m[1]] = m[2];
  }

// curated handoff: the post-fix projection — coherent continuation = "run the tests"
const state = curate(buildFixture());
const ask = "\n\nYou are taking over from another agent and only have the context above. In ONE sentence: what is the single next action?";
const withAsk = { ...state, openTask: state.openTask + ask };

const trunc = (s: string, n = 240) => (s.length > n ? s.slice(0, n) + "…" : s);

async function hit(name: string, fn: () => Promise<Response>, extract: (j: any) => string) {
  try {
    const res = await fn();
    const body = await res.text();
    let reply = "";
    try { reply = extract(JSON.parse(body)); } catch { reply = trunc(body); }
    console.log(`\n${name}: HTTP ${res.status} ${res.status === 200 ? "✅ accepted" : "❌"}`);
    console.log(`  model reply / error: ${trunc(reply || body)}`);
  } catch (e: any) {
    console.log(`\n${name}: request failed — ${trunc(String(e))}`);
  }
}

console.log("LIVE CHECK — POST curated payloads to real provider APIs (keys never printed)");
let any = false;

if (keys.ANTHROPIC_API_KEY) {
  any = true;
  const p = renderAnthropic(withAsk); p.model = keys.ANTHROPIC_MODEL || "claude-haiku-4-5";
  await hit("anthropic", () => fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": keys.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(p),
  }), (j) => j.content?.map((b: any) => b.text).filter(Boolean).join(" ") ?? j.error?.message);
}

if (keys.OPENAI_API_KEY) {
  any = true;
  const p = renderOpenAI(withAsk); p.model = keys.OPENAI_MODEL || "gpt-5.4";
  await hit("openai", () => fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${keys.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(p),
  }), (j) => j.choices?.[0]?.message?.content ?? j.error?.message);
}

if (keys.DEEPSEEK_API_KEY) {
  any = true;
  const p = renderOpenAI(withAsk); p.model = keys.DEEPSEEK_MODEL || "deepseek-chat";
  await hit("deepseek", () => fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${keys.DEEPSEEK_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(p),
  }), (j) => j.choices?.[0]?.message?.content ?? j.error?.message);
}

if (keys.OPENROUTER_API_KEY) {
  any = true;
  const p = renderOpenAI(withAsk); p.model = keys.OPENROUTER_MODEL || "google/gemini-2.5-flash";
  await hit("openrouter", () => fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${keys.OPENROUTER_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(p),
  }), (j) => j.choices?.[0]?.message?.content ?? j.error?.message);
}

if (keys.GEMINI_API_KEY) {
  any = true;
  const model = keys.GEMINI_MODEL || "gemini-2.5-flash";
  const p = renderGemini(withAsk);
  // key in query string — build URL locally, never log it
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${keys.GEMINI_API_KEY}`;
  await hit("gemini", () => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p) }),
    (j) => j.candidates?.[0]?.content?.parts?.map((x: any) => x.text).join(" ") ?? j.error?.message);
}

if (!any) {
  console.log("\nNo provider key found. Drop ONE throwaway key into experiments/.env.local, e.g.:");
  console.log("  GEMINI_API_KEY=...   (or ANTHROPIC_API_KEY / OPENAI_API_KEY / DEEPSEEK_API_KEY / OPENROUTER_API_KEY)");
  console.log("Then: bun run experiments/live-check/run.ts   — the key is read from the file and never printed.");
}
