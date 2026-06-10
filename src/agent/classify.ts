// LLM task classifier — a small, cheap model reads the prompt and picks the task
// "kind" the router uses to set its quality bar. Crude but far better than keyword
// matching: it actually understands that "what does this regex do?" is a light chat
// task (→ Haiku) while "design a lock-free allocator" is heavy (→ Sonnet/Opus).
//
// It runs ASYNC, so the agent calls it BEFORE the (synchronous) selector seam and
// passes the resulting kind into select(). It ALWAYS degrades to the keyword
// classifier — no API-key/in-loop model, offline, timeout, or a junk reply all fall
// back, so a turn never blocks on routing. Cost is one tiny call on the cheapest model.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { runCompletion } from "./run.ts";
import { recordSpend, resolveTurnCost } from "../accounts/ledger.ts";
import { resolveCreds } from "../accounts/resolve.ts";
import { classify as keywordClassify, confidentKeywordKind } from "../model/router.ts";
import { profileFor } from "../model/profiles.ts";
import { modelRegistry, providerAvailable, type ModelSpec } from "../providers.ts";
import { accountsForProvider } from "../accounts/store.ts";
import type { Account } from "../accounts/types.ts";
import type { Task } from "../model/selector.ts";

export type TaskKind = NonNullable<Task["kind"]>;
const KINDS = new Set<TaskKind>(["summarize", "classify", "search", "chat", "plan", "code"]);

/** Where the kind came from — surfaced in /why so a fallback default ("code"
 *  because the classifier was unavailable) is never mistaken for a real verdict. */
export type ClassifySource = "keyword" | "cache" | "llm" | "fallback";
export interface Classification { kind: TaskKind; source: ClassifySource }

const SYSTEM = [
  "You are the task router for a terminal coding assistant. Read the user's message and reply with the SINGLE best category, choosing the LIGHTEST category that can still produce a correct, high-quality answer — lighter categories run on cheaper, faster models, so routing easy work down saves money.",
  "",
  "Categories, lightest to heaviest:",
  "- summarize — condense, recap, or TL;DR some provided text.",
  "- classify — label, tag, categorize, extract a field, or make a yes/no judgement.",
  "- search — locate where something is: find a file, a symbol, a definition, or a usage.",
  "- chat — answer a question, explain a concept / snippet / error / regex / command, define a term, or hold a normal conversation. Anything a competent small model can answer correctly in one shot WITHOUT writing or changing code.",
  "- code — write, edit, refactor, debug, fix, or generate real code; trace logic across files; anything where subtle correctness matters.",
  "- plan — design an architecture or approach, weigh non-trivial tradeoffs, or lay out a multi-step change before coding.",
  "",
  "Rules:",
  "- Default to 'chat' for explanations and questions. Escalate to 'code' or 'plan' only when the task genuinely requires producing/altering code or hard multi-step reasoning.",
  "- A request to change, write, or fix code is 'code' even when phrased as a question.",
  "- If two categories fit and differ in weight, pick the heavier one — correctness beats cost when you're unsure.",
  "",
  "Examples:",
  "- 'tl;dr this error log' → summarize",
  "- 'is this function pure? yes or no' → classify",
  "- 'where is the retry logic defined?' → search",
  "- 'what does this regex match?' → chat",
  "- 'why is this throwing undefined?' → code (debugging needs the code path traced)",
  "- 'add a --json flag to the export command' → code",
  "- 'how should we split this service before adding multi-tenancy?' → plan",
  "",
  "Output ONLY the category word. No punctuation, no explanation.",
].join("\n");

// The cheapest in-loop model with usable creds. Subscription seats are excluded —
// they run via the vendor CLI and can't serve a raw completion. Cost, then speed.
function cheapestInLoop(): { model: ModelSpec; account?: Account } | null {
  let best: { model: ModelSpec; account?: Account; cost: number; tps: number } | null = null;
  let fallback: { model: ModelSpec; account?: Account; cost: number } | null = null;
  for (const m of modelRegistry()) {
    if (!providerAvailable(m.provider)) continue;
    const account = accountsForProvider(m.provider).filter((a) => a.enabled && a.exec !== "cli")[0];
    const pr = profileFor(m.id);
    const cost = pr?.cost?.inUSDPerMtok ?? m.cost?.inUSDPerMtok ?? 1e6;
    const tps = pr?.latency?.tps ?? m.speed?.tps ?? 0;
    if (!fallback || cost < fallback.cost) fallback = { model: m, account, cost };
    // Quality floor (R-6): a sub-haiku-class model (e.g. nova-micro ≈0.25) misclassifies
    // AND the verdict is cached for 256 prompts. Unknown profile → 0.5 (don't exclude);
    // falls back to the cheapest if nothing clears the floor.
    const q = pr?.quality?.sweBenchVerified ?? ((pr?.quality?.intelligenceIndex ?? 50) / 100);
    if (q < 0.3) continue;
    if (!best || cost < best.cost || (cost === best.cost && tps > best.tps)) best = { model: m, account, cost, tps };
  }
  const pick = best ?? fallback;
  return pick ? { model: pick.model, account: pick.account } : null;
}

// Cache persists across runs so a repeated prompt never re-pays the model call.
const cacheFile = () => join(process.env.GEARBOX_HOME || join(homedir(), ".gearbox"), "classify-cache.json");
let cache: Map<string, TaskKind> | null = null;
function loadCache(): Map<string, TaskKind> {
  if (cache) return cache;
  cache = new Map();
  try {
    const obj = JSON.parse(readFileSync(cacheFile(), "utf8"));
    for (const [k, v] of Object.entries(obj)) if (KINDS.has(v as TaskKind)) cache.set(k, v as TaskKind);
  } catch { /* none yet */ }
  return cache;
}
function saveCache(c: Map<string, TaskKind>): void {
  try {
    mkdirSync(join(process.env.GEARBOX_HOME || join(homedir(), ".gearbox")), { recursive: true });
    writeFileSync(cacheFile(), JSON.stringify(Object.fromEntries(c)), { mode: 0o600 });
  } catch { /* best-effort */ }
}

/** Classify a prompt into a routing kind (+ where the verdict came from).
 *  Fast path: a confident keyword match (mutation → code, summarize/classify/
 *  search markers) skips the model call entirely — only genuinely ambiguous
 *  prompts (bare questions/explanations) pay the ~1-2s LLM hop. Cached across
 *  runs; falls back to keyword on any failure. */
export async function classifyTask(prompt: string, signal?: AbortSignal): Promise<Classification> {
  const key = prompt.trim();
  if (!key) return { kind: "code", source: "fallback" };
  // Fast path: clear signal → no model call.
  const confident = confidentKeywordKind(prompt);
  if (confident) return { kind: confident, source: "keyword" };
  const c = loadCache();
  const cached = c.get(key);
  if (cached) return { kind: cached, source: "cache" };
  const fallback = keywordClassify(prompt); // "chat" for bare questions, else "code"
  const pick = cheapestInLoop();
  if (!pick) return { kind: fallback, source: "fallback" }; // subscription-only / no key → keyword
  try {
    const creds = pick.account ? await resolveCreds(pick.account) : undefined;
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort);
    const timer = setTimeout(() => ctrl.abort(), 3500); // never block the turn for long
    let text = "";
    try {
      const r = await runCompletion({ model: pick.model, system: SYSTEM, prompt: key.slice(0, 4000), onEvent: () => {}, signal: ctrl.signal, creds });
      text = r.text ?? "";
      // SPEND TRUTH: this is a real billed call — it must hit the ledger like
      // every other dollar. It was invisible before (charges on a provider the
      // user never saw a line for).
      try {
        recordSpend({
          accountId: pick.account?.id ?? `env:${pick.model.provider}`,
          model: pick.model.id, source: "aux",
          inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens,
          ...resolveTurnCost({ modelId: pick.model.id, isSub: false, usage: r.usage }),
          at: Date.now(),
        });
      } catch { /* never break classification over bookkeeping */ }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    const word = text.toLowerCase().match(/[a-z]+/g)?.find((w) => KINDS.has(w as TaskKind)) as TaskKind | undefined;
    // Only cache a real model verdict (not the keyword fallback) so a transient
    // failure doesn't pin the wrong kind forever.
    if (word) {
      if (c.size > 256) { for (const k of [...c.keys()].slice(0, 64)) c.delete(k); } // trim oldest
      c.set(key, word);
      saveCache(c);
      return { kind: word, source: "llm" };
    }
    return { kind: fallback, source: "fallback" };
  } catch {
    return { kind: fallback, source: "fallback" };
  }
}
