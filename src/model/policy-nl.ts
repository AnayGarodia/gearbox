// Plain-English policy parser — turn a sentence like "don't use chinese models"
// or "burn my openai credits first" into structured policy ops the preference
// layer can apply. Mirrors src/agent/classify.ts: a DETERMINISTIC fast path
// handles the common phrasings for free (pure, testable, offline), and only a
// genuinely ambiguous sentence pays a cheap LLM hop — which ALWAYS degrades to
// null (the caller then says it didn't understand), so policy parsing can never
// block or surprise-bill a turn.
//
// NOTE: PolicyOps is defined HERE to match the contract preferences.ts is
// growing — deliberately NOT imported from preferences.ts; the wiring layer
// connects the two so this module stays pure + dependency-light.
import { runCompletion } from "../agent/run.ts";
import { recordSpend, resolveTurnCost } from "../accounts/ledger.ts";
import { resolveCreds } from "../accounts/resolve.ts";
import { profileFor } from "./profiles.ts";
import { modelRegistry, providerAvailable, type ModelSpec } from "../providers.ts";
import { accountsForProvider } from "../accounts/store.ts";
import type { Account } from "../accounts/types.ts";

/** The structured ops a preference sentence can request. Matches the shape
 *  preferences.ts applies — keep the two in sync (the contract, not an import). */
export type PolicyOps = {
  avoidProviders?: { add?: string[]; remove?: string[] };
  avoidModels?: { add?: string[]; remove?: string[] };
  accountOrder?: { set?: string[] };
  useFirst?: { set?: string[] };
  prefer?: "subscription" | "api" | null;
  budget?: { key: string; amountUSD: number | null; period?: "total" | "monthly" };
};

/** What the parser matches names against — the LIVE lists, passed in so this
 *  module stays pure (no store/registry reads on the fast path). */
export interface PolicyCtx {
  providers: string[];
  models: string[];
  accounts: { id: string; slug: string }[];
}

// "chinese models" is a real way users phrase a compliance/avoid rule — expand
// it to the providers in our catalog rather than making them list each one.
const CHINESE_PROVIDERS = ["deepseek", "moonshot", "zai", "minimax"];

const norm = (s: string) => s.toLowerCase().trim();

/** Case-insensitive name match against a ctx list: exact first, then a
 *  whole-word-ish containment either way ("openai" matches "azure-openai"
 *  only via the canonical list order — exact wins, so ambiguity stays cheap). */
function matchName(token: string, list: string[]): string | undefined {
  const t = norm(token);
  if (!t) return undefined;
  const exact = list.find((x) => norm(x) === t);
  if (exact) return exact;
  // Fuzzy tiers only for tokens long enough to carry signal — a 1–2 char
  // token would containment-match half the catalog ("x" → "xai") and apply a
  // hard avoid rule the user never said.
  if (t.length < 3) return undefined;
  const prefix = list.find((x) => norm(x).startsWith(t));
  if (prefix) return prefix;
  return list.find((x) => norm(x).includes(t) || t.includes(norm(x)));
}

/** Resolve a fragment to ONE account: exact slug first; otherwise the LONGEST
 *  contained slug wins, so "claude-work" never resolves to a sibling "claude"
 *  account that merely prefixes it (slugs are not prefix-free by convention). */
function matchAccount(fragment: string, ctx: PolicyCtx): { id: string; slug: string } | undefined {
  const f = norm(fragment);
  const exact = ctx.accounts.find((a) => norm(a.slug) === f);
  if (exact) return exact;
  return [...ctx.accounts].sort((a, b) => b.slug.length - a.slug.length).find((a) => f.includes(norm(a.slug)));
}

/** Pull every provider/model name a free-text fragment mentions. Splits on
 *  the natural separators so "deepseek and groq" or "deepseek, groq" both work. */
function namesIn(fragment: string, ctx: PolicyCtx): { providers: string[]; models: string[] } {
  const providers: string[] = [];
  const models: string[] = [];
  for (const raw of fragment.split(/,|\band\b|\bor\b|\//)) {
    const tok = norm(raw).replace(/\b(models?|providers?|the|my|any|all)\b/g, "").trim();
    if (!tok) continue;
    const p = matchName(tok, ctx.providers);
    if (p) { if (!providers.includes(p)) providers.push(p); continue; }
    const m = matchName(tok, ctx.models);
    if (m && !models.includes(m)) models.push(m);
  }
  return { providers, models };
}

/** Deterministic fast path — the common phrasings, no model call. Pure: the
 *  only inputs are the sentence and the ctx lists. Returns null when nothing
 *  matched confidently (the caller may then try the LLM fallback). */
export function parsePolicyFast(text: string, ctx: PolicyCtx): PolicyOps | null {
  const t = norm(text).replace(/[.!?]+$/, "");
  if (!t) return null;

  // --- prefer: "subscription(s) only" / "api only" / "no preference" -------
  if (/^(use\s+)?subscriptions?(\s+seats?)?\s+only$/.test(t) || /^only\s+(use\s+)?subscriptions?$/.test(t)) return { prefer: "subscription" };
  if (/^(use\s+)?api(\s+keys?)?\s+only$/.test(t) || /^only\s+(use\s+)?api(\s+keys?)?$/.test(t)) return { prefer: "api" };
  if (/^no preference$/.test(t) || /^clear( preferences?)?$/.test(t)) return { prefer: null };
  // The exact undo phrasings describePolicy() prints MUST parse deterministically
  // — the app's own printed instructions can never depend on the LLM hop.
  if (/^account order clear$/.test(t) || /^clear (the )?account order$/.test(t)) return { accountOrder: { set: [] } };
  if (/^use first clear$/.test(t) || /^clear use first$/.test(t)) return { useFirst: { set: [] } };

  // --- budget: "i have $40 of openai credits" / "$25 in deepseek" ----------
  // Money + a provider name reads as a self-declared balance (period: total).
  {
    // Suffix-aware: "$5k" is $5,000, "$1.2m" is $1,200,000, "$5,000" strips
    // commas. Any OTHER letter glued to the number means we did not understand
    // the amount — bail to the LLM rather than silently store a wrong figure.
    const m = t.match(/\$\s*([\d,]+(?:\.\d+)?)([a-z]?)/); // suffix must be GLUED to the number ("$5k", not the "o" of "$40 of")
    if (m && /credits?|balance|\bin\b|\bof\b|\bon\b|have|left/.test(t)) {
      const suffix = m[2] || "";
      const mult = suffix === "k" ? 1e3 : suffix === "m" ? 1e6 : suffix === "" ? 1 : null;
      if (mult != null) {
        const { providers } = namesIn(t.replace(m[0], " "), ctx);
        if (providers.length === 1) {
          return { budget: { key: providers[0]!, amountUSD: Number(m[1]!.replace(/,/g, "")) * mult, period: "total" } };
        }
      }
    }
  }

  // --- useFirst: "burn/spend/use the openai credits first" -----------------
  // Checked BEFORE avoid ("use X first" must not read as plain "use"). An
  // account slug wins over a provider name (more specific).
  {
    const m = t.match(/^(?:burn|spend|use)\s+(?:through\s+)?(.+?)\s*(?:credits?|balance)?\s+first$/);
    if (m) {
      const frag = m[1]!;
      const acct = matchAccount(frag, ctx);
      if (acct) return { useFirst: { set: [acct.slug] } };
      const { providers } = namesIn(frag, ctx);
      if (providers.length > 0) return { useFirst: { set: providers } };
      return null;
    }
  }

  // --- accountOrder: "use A before B" / "A first, then B" ------------------
  // Both names must be ACCOUNTS — provider-only mentions fall through.
  {
    const m =
      t.match(/^(?:use|prefer)\s+(.+?)\s+before\s+(.+)$/) ??
      t.match(/^(.+?)\s+first,?\s*(?:and\s+)?then\s+(.+)$/);
    if (m) {
      const a = matchAccount(m[1]!, ctx);
      const b = matchAccount(m[2]!, ctx);
      if (a && b && a.slug !== b.slug) return { accountOrder: { set: [a.slug, b.slug] } };
      // Fell through: looked like an ordering but names didn't both resolve.
      // Don't return null yet — "prefer X" alone may still be an avoid/allow miss.
    }
  }

  // --- avoid: "no/avoid/don't use/never use/block X" ------------------------
  {
    const m = t.match(/^(?:no|avoid|block|ban|don'?t use|do not use|never use|stop using)\s+(.+)$/);
    if (m) {
      const frag = m[1]!;
      if (/chinese/.test(frag)) {
        // Only add the chinese providers actually in this ctx's catalog form.
        const add = CHINESE_PROVIDERS.map((p) => matchName(p, ctx.providers) ?? p);
        return { avoidProviders: { add } };
      }
      const { providers, models } = namesIn(frag, ctx);
      const ops: PolicyOps = {};
      if (providers.length) ops.avoidProviders = { add: providers };
      if (models.length) ops.avoidModels = { add: models };
      return providers.length || models.length ? ops : null;
    }
  }

  // --- allow: "allow/unblock/re-enable X" → remove from the avoid lists -----
  {
    const m = t.match(/^(?:allow|unblock|re-?enable|permit)\s+(.+)$/);
    if (m) {
      if (/chinese/.test(m[1]!)) {
        return { avoidProviders: { remove: CHINESE_PROVIDERS.map((p) => matchName(p, ctx.providers) ?? p) } };
      }
      const { providers, models } = namesIn(m[1]!, ctx);
      const ops: PolicyOps = {};
      if (providers.length) ops.avoidProviders = { remove: providers };
      if (models.length) ops.avoidModels = { remove: models };
      return providers.length || models.length ? ops : null;
    }
  }

  return null; // ambiguous — caller may escalate to the LLM fallback
}

// The cheapest in-loop model with usable creds — same selection as classify.ts:
// subscription seats excluded (CLI seats can't serve a raw completion), a
// quality floor so a sub-haiku model doesn't garble structured JSON.
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
    const q = pr?.quality?.sweBenchVerified ?? ((pr?.quality?.intelligenceIndex ?? 50) / 100);
    if (q < 0.3) continue;
    if (!best || cost < best.cost || (cost === best.cost && tps > best.tps)) best = { model: m, account, cost, tps };
  }
  const pick = best ?? fallback;
  return pick ? { model: pick.model, account: pick.account } : null;
}

function systemPrompt(ctx: PolicyCtx): string {
  return [
    "You parse a user's plain-English routing-policy sentence for a terminal coding assistant into STRICT JSON. Output ONLY a single JSON object, no prose, no markdown fences.",
    "",
    "JSON shape (include ONLY the fields the sentence asks for):",
    '{ "avoidProviders": {"add": [..], "remove": [..]}, "avoidModels": {"add": [..], "remove": [..]}, "accountOrder": {"set": [..]}, "useFirst": {"set": [..]}, "prefer": "subscription"|"api"|null, "budget": {"key": "<provider-or-account>", "amountUSD": <number|null>, "period": "total"|"monthly"} }',
    "",
    `Known providers: ${ctx.providers.join(", ") || "(none)"}`,
    `Known models: ${ctx.models.slice(0, 60).join(", ") || "(none)"}`,
    `Known accounts (slugs): ${ctx.accounts.map((a) => a.slug).join(", ") || "(none)"}`,
    "",
    "Rules:",
    "- Use ONLY names from the known lists above; never invent names.",
    "- 'chinese models' means the providers: deepseek, moonshot, zai, minimax (those present in the known list).",
    "- accountOrder/useFirst use account slugs; avoid lists use provider/model ids.",
    "- If the sentence is not a routing-policy statement, output exactly: null",
  ].join("\n");
}

/** Extract the first balanced {...} block — models love to wrap JSON in prose
 *  or fences; we only need the object. */
function firstJsonBlock(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/** Validate + prune a parsed object down to the PolicyOps contract. Anything
 *  off-shape is dropped (never throws); an empty result is null. */
function sanitize(raw: unknown): PolicyOps | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const strs = (v: unknown): string[] | undefined => {
    const a = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];
    return a.length ? a : undefined;
  };
  const addRemove = (v: unknown): { add?: string[]; remove?: string[] } | undefined => {
    if (!v || typeof v !== "object") return undefined;
    const add = strs((v as any).add), remove = strs((v as any).remove);
    return add || remove ? { ...(add && { add }), ...(remove && { remove }) } : undefined;
  };
  const out: PolicyOps = {};
  const ap = addRemove(o.avoidProviders); if (ap) out.avoidProviders = ap;
  const am = addRemove(o.avoidModels); if (am) out.avoidModels = am;
  const ao = strs((o.accountOrder as any)?.set); if (ao) out.accountOrder = { set: ao };
  const uf = strs((o.useFirst as any)?.set); if (uf) out.useFirst = { set: uf };
  if (o.prefer === "subscription" || o.prefer === "api" || o.prefer === null) out.prefer = o.prefer as PolicyOps["prefer"];
  const b = o.budget as any;
  if (b && typeof b === "object" && typeof b.key === "string" && (typeof b.amountUSD === "number" || b.amountUSD === null)) {
    out.budget = { key: b.key, amountUSD: b.amountUSD, ...(b.period === "total" || b.period === "monthly" ? { period: b.period } : {}) };
  }
  return Object.keys(out).length ? out : null;
}

/** Parse a policy sentence: deterministic fast path first, then a cheap LLM
 *  hop for ambiguous phrasings. Returns null when neither understood it —
 *  the caller should say so rather than guess. Never throws; never blocks
 *  longer than ~3.5s. */
export async function parsePolicyNL(text: string, ctx: PolicyCtx, signal?: AbortSignal): Promise<PolicyOps | null> {
  const fast = parsePolicyFast(text, ctx);
  if (fast) return fast;
  const pick = cheapestInLoop();
  if (!pick) return null; // subscription-only / no key → fast path was the only shot
  try {
    const creds = pick.account ? await resolveCreds(pick.account) : undefined;
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort);
    const timer = setTimeout(() => ctrl.abort(), 3500); // never block the turn for long
    let out = "";
    try {
      const r = await runCompletion({ model: pick.model, system: systemPrompt(ctx), prompt: text.slice(0, 2000), onEvent: () => {}, signal: ctrl.signal, creds });
      out = r.text ?? "";
      // SPEND TRUTH: a real billed call must hit the ledger like every other dollar.
      try {
        recordSpend({
          accountId: pick.account?.id ?? `env:${pick.model.provider}`,
          model: pick.model.id, source: "aux",
          inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens,
          ...resolveTurnCost({ modelId: pick.model.id, isSub: false, usage: r.usage }),
          at: Date.now(),
        });
      } catch { /* never break parsing over bookkeeping */ }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    const block = firstJsonBlock(out);
    if (!block) return null;
    try { return sanitize(JSON.parse(block)); } catch { return null; }
  } catch {
    return null;
  }
}
