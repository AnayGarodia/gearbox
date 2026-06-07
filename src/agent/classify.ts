// LLM task classifier — a small, cheap model reads the prompt and picks the task
// "kind" the router uses to set its quality bar. Crude but far better than keyword
// matching: it actually understands that "what does this regex do?" is a light chat
// task (→ Haiku) while "design a lock-free allocator" is heavy (→ Sonnet/Opus).
//
// It runs ASYNC, so the agent calls it BEFORE the (synchronous) selector seam and
// passes the resulting kind into select(). It ALWAYS degrades to the keyword
// classifier — no API-key/in-loop model, offline, timeout, or a junk reply all fall
// back, so a turn never blocks on routing. Cost is one tiny call on the cheapest model.
import { runCompletion } from "./run.ts";
import { resolveCreds } from "../accounts/resolve.ts";
import { classify as keywordClassify } from "../model/router.ts";
import { profileFor } from "../model/profiles.ts";
import { modelRegistry, providerAvailable, type ModelSpec } from "../providers.ts";
import { accountsForProvider } from "../accounts/store.ts";
import type { Account } from "../accounts/types.ts";
import type { Task } from "../model/selector.ts";

export type TaskKind = NonNullable<Task["kind"]>;
const KINDS = new Set<TaskKind>(["summarize", "classify", "search", "chat", "plan", "code"]);

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
  "Output ONLY the category word. No punctuation, no explanation.",
].join("\n");

// The cheapest in-loop model with usable creds. Subscription seats are excluded —
// they run via the vendor CLI and can't serve a raw completion. Cost, then speed.
function cheapestInLoop(): { model: ModelSpec; account?: Account } | null {
  let best: { model: ModelSpec; account?: Account; cost: number; tps: number } | null = null;
  for (const m of modelRegistry()) {
    if (!providerAvailable(m.provider)) continue;
    const account = accountsForProvider(m.provider).filter((a) => a.enabled && a.exec !== "cli")[0];
    const pr = profileFor(m.id);
    const cost = pr?.cost?.inUSDPerMtok ?? m.cost?.inUSDPerMtok ?? 1e6;
    const tps = pr?.latency?.tps ?? m.speed?.tps ?? 0;
    if (!best || cost < best.cost || (cost === best.cost && tps > best.tps)) best = { model: m, account, cost, tps };
  }
  return best ? { model: best.model, account: best.account } : null;
}

const cache = new Map<string, TaskKind>(); // by prompt — avoids re-classifying retries/failover

/** Classify a prompt into a routing kind using a cheap model. Falls back to the
 *  keyword classifier on any failure. Best-effort; never throws. */
export async function classifyTask(prompt: string, signal?: AbortSignal): Promise<TaskKind> {
  const key = prompt.trim();
  const cached = cache.get(key);
  if (cached) return cached;
  const fallback = keywordClassify(prompt);
  if (!key) return fallback;
  const pick = cheapestInLoop();
  if (!pick) return fallback; // subscription-only / no key → keyword
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
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    const word = text.toLowerCase().match(/[a-z]+/g)?.find((w) => KINDS.has(w as TaskKind)) as TaskKind | undefined;
    const kind = word ?? fallback;
    if (cache.size > 64) cache.clear();
    cache.set(key, kind);
    return kind;
  } catch {
    return fallback;
  }
}
