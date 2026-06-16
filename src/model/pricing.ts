// COMPREHENSIVE LIST-PRICE TABLE — the cost-data completeness layer.
//
// The cost engine (providers.ts estimateCost / costFor) resolves a model's price
// from: the curated spec → the PROFILES corpus → this table → a last-resort
// fuzzy canonical match. Curated/profile prices always win; this table fills the
// long tail (every model the June-2026 research priced) so a discovered Azure
// deployment or a gateway id estimates real cost instead of "$ unknown".
//
// PROVIDER-SCOPED on purpose: the SAME model costs differently per host. Native
// DeepSeek-V4-Pro is ~$0.44/$0.87; the same model on Azure AI Foundry is
// ~$1.93/$3.83 (live-pulled from the aztea-foundry account). A flat table would
// mis-bill whichever host you actually run on. SCOPED[provider] overrides GENERIC.
//
// All values USD per 1M tokens. `src`: "live" = pulled from a real account,
// "researched" = provider docs/pricing page (cited in the design doc),
// "seeded" = best-effort where the page was JS-gated or host-variable. Pure.

import type { ProviderId } from "../providers.ts";

export interface Price {
  in: number;
  out: number;
  /** Cached-input read rate where the provider publishes one. estimateCost uses
   *  it for the cache-read term (via priceMetaFor), replacing the flat 0.1x
   *  fallback when present. */
  cachedIn?: number;
  /** Per-request surcharge (e.g. Perplexity Sonar search fee), USD per request.
   *  estimateCost adds it once per turn (via priceMetaFor). */
  perRequestUSD?: number;
  src: "live" | "researched" | "seeded";
}

const R = "researched" as const;

// Generic / list (native-API) prices keyed by NORMALIZED family id (lowercase,
// dashed, date-stamp stripped — see normalizeId below).
// NOTE: GENERIC must NOT duplicate a curated model id (those carry spec.cost,
// which wins in costFor — a duplicate here would be dead, conflicting data). The
// long tail only; the collision guard in pricing.test.ts enforces this. Models
// already curated (gpt-5.5, gpt-5.5-pro, deepseek-v4-pro/flash, gemini-3.1-pro,
// gemini-3.5-flash) are intentionally absent. (N7)
const GENERIC: Record<string, Price> = {
  // ── OpenAI (platform.openai.com/pricing; Azure mirrors list per MS docs) ──
  "gpt-5.4": { in: 2.5, out: 15, cachedIn: 0.25, src: R },
  "gpt-5.4-mini": { in: 0.75, out: 4.5, cachedIn: 0.075, src: R },
  "gpt-5.4-nano": { in: 0.2, out: 1.25, cachedIn: 0.02, src: R },
  "gpt-5.4-pro": { in: 30, out: 180, src: R },
  "gpt-5.3-codex": { in: 1.75, out: 14, cachedIn: 0.175, src: R },
  "gpt-5.3-chat": { in: 1.75, out: 14, src: R },
  "gpt-5.2": { in: 2.5, out: 15, src: R },
  "gpt-5.2-codex": { in: 1.75, out: 14, src: R },
  "gpt-5.1": { in: 2.5, out: 15, src: R },
  "gpt-5.1-codex": { in: 1.75, out: 14, src: R },
  "gpt-5.1-codex-max": { in: 1.75, out: 14, src: R },
  "gpt-5-codex": { in: 1.75, out: 14, src: R },
  "gpt-5-mini": { in: 0.25, out: 2, cachedIn: 0.025, src: R },
  "gpt-5-nano": { in: 0.05, out: 0.4, cachedIn: 0.005, src: R },
  o3: { in: 2, out: 8, src: R },
  "o3-pro": { in: 20, out: 80, src: R },
  "o3-mini": { in: 1.1, out: 4.4, cachedIn: 0.55, src: R },
  "o4-mini": { in: 1.1, out: 4.4, cachedIn: 0.275, src: R },
  o1: { in: 15, out: 60, src: R },
  "o1-mini": { in: 1.1, out: 4.4, src: R },
  "codex-mini": { in: 1.5, out: 6, src: R },
  "gpt-4o": { in: 2.5, out: 10, cachedIn: 1.25, src: R },
  "gpt-4o-mini": { in: 0.15, out: 0.6, cachedIn: 0.075, src: R },
  "gpt-4.1": { in: 2, out: 8, cachedIn: 0.5, src: R },
  "gpt-4.1-mini": { in: 0.4, out: 1.6, cachedIn: 0.1, src: R },
  "gpt-4.1-nano": { in: 0.1, out: 0.4, cachedIn: 0.025, src: R },
  "gpt-oss-120b": { in: 0.15, out: 0.6, src: "seeded" },
  "gpt-oss-20b": { in: 0.075, out: 0.3, src: "seeded" },

  // ── xAI (docs.x.ai) ──
  "grok-4": { in: 3, out: 15, cachedIn: 0.75, src: R },
  "grok-4-0709": { in: 3, out: 15, cachedIn: 0.75, src: R },
  "grok-4.3": { in: 1.25, out: 2.5, cachedIn: 0.2, src: R },
  "grok-4-fast": { in: 0.2, out: 0.5, cachedIn: 0.05, src: R },
  "grok-4-fast-reasoning": { in: 0.2, out: 0.5, cachedIn: 0.05, src: R },
  "grok-4-fast-non-reasoning": { in: 0.2, out: 0.5, cachedIn: 0.05, src: R },
  "grok-4-1-fast-reasoning": { in: 0.2, out: 0.5, cachedIn: 0.05, src: R },
  "grok-code-fast-1": { in: 0.2, out: 1.5, cachedIn: 0.02, src: R },
  "grok-3": { in: 3, out: 15, cachedIn: 0.75, src: R },
  "grok-3-mini": { in: 0.3, out: 0.5, src: R },

  // ── DeepSeek native (api-docs.deepseek.com) — v4-pro/v4-flash are curated ──
  "deepseek-v3.2": { in: 0.28, out: 0.42, cachedIn: 0.028, src: R },
  "deepseek-v3.1": { in: 0.28, out: 0.42, src: R },
  "deepseek-r1": { in: 0.55, out: 2.19, src: R },
  "deepseek-chat": { in: 0.14, out: 0.28, src: R },
  "deepseek-reasoner": { in: 0.55, out: 2.19, src: R },

  // ── Moonshot Kimi (platform.kimi.ai) ──
  "kimi-k2.7-code": { in: 0.95, out: 4, cachedIn: 0.16, src: R },
  "kimi-k2.6": { in: 0.95, out: 4, cachedIn: 0.16, src: R },
  "kimi-k2.5": { in: 0.6, out: 3, cachedIn: 0.1, src: R },
  "moonshot-v1-128k": { in: 2, out: 5, src: R },

  // ── Z.ai GLM (docs.z.ai, intl USD) ──
  "glm-4.6": { in: 0.6, out: 2.2, cachedIn: 0.11, src: R },
  "glm-4.5": { in: 0.6, out: 2.2, src: R },
  "glm-4.5-air": { in: 0.2, out: 1.1, cachedIn: 0.03, src: R },
  "glm-4.5-x": { in: 2.2, out: 8.9, cachedIn: 0.45, src: R },
  "glm-4.5-flash": { in: 0, out: 0, src: R },

  // ── MiniMax (platform.minimax.io, intl USD) ──
  "minimax-m3": { in: 0.3, out: 1.2, src: "seeded" },
  "minimax-m2.7": { in: 0.25, out: 1, src: R },
  "minimax-m2": { in: 0.255, out: 1, src: R },
  "minimax-m1": { in: 0.4, out: 2.2, src: R },
  "minimax-text-01": { in: 0.2, out: 1.1, src: R },

  // ── Mistral (mistral.ai/pricing) ──
  "mistral-large-3": { in: 0.5, out: 1.5, src: R },
  "mistral-large": { in: 2, out: 6, src: R },
  "mistral-medium-3": { in: 0.4, out: 2, src: R },
  "mistral-medium": { in: 0.4, out: 2, src: R },
  "mistral-small": { in: 0.15, out: 0.6, src: R },
  "codestral": { in: 0.3, out: 0.9, src: R },
  "codestral-2508": { in: 0.3, out: 0.9, src: R },
  "magistral-medium": { in: 2, out: 5, src: R },
  "magistral-small": { in: 0.5, out: 1.5, src: R },
  "ministral-8b": { in: 0.15, out: 0.15, src: R },
  "ministral-3b": { in: 0.1, out: 0.1, src: R },
  "pixtral-large": { in: 2, out: 6, src: R },
  "devstral": { in: 0.4, out: 2, src: R },

  // ── Google Gemini (cloud.google.com pricing) — 3.1-pro/3.5-flash are curated ──
  "gemini-3-flash": { in: 0.5, out: 3, src: R },
  "gemini-2.5-pro": { in: 1.25, out: 10, src: R },
  "gemini-2.5-flash": { in: 0.3, out: 2.5, src: R },

  // ── Meta / open-weight reference (varies by host; representative) ──
  "llama-4-maverick": { in: 0.24, out: 0.85, src: "seeded" },
  "llama-4-scout": { in: 0.15, out: 0.6, src: "seeded" },
  "qwen3-235b": { in: 0.2, out: 0.6, src: "seeded" },
  "qwen3-32b": { in: 0.29, out: 0.59, src: "seeded" },

  // ── Perplexity (docs.perplexity.ai — tokens + per-request search fee) ──
  "sonar": { in: 1, out: 1, perRequestUSD: 0.008, src: R },
  "sonar-pro": { in: 3, out: 15, perRequestUSD: 0.01, src: R },
  "sonar-reasoning": { in: 1, out: 5, perRequestUSD: 0.008, src: R },
  "sonar-reasoning-pro": { in: 2, out: 8, perRequestUSD: 0.01, src: R },
  "sonar-deep-research": { in: 2, out: 8, perRequestUSD: 0.005, src: R },
  "r1-1776": { in: 2, out: 8, src: R },
};

// Provider-scoped overrides: same model id, host-specific price. Keyed
// [provider][normalizedId]. Foundry rates are LIVE-pulled from the real account.
const SCOPED: Partial<Record<ProviderId, Record<string, Price>>> = {
  "azure-foundry": {
    // Live from aztea-foundry retail prices (≈ DataZone Standard).
    "deepseek-v4-pro": { in: 1.925, out: 3.828, cachedIn: 0.165, src: "live" },
    "kimi-k2.6": { in: 1.045, out: 4.4, cachedIn: 0.176, src: "live" },
    "kimi-k2.5": { in: 0.66, out: 3.3, cachedIn: 0.11, src: "live" },
    // Azure OpenAI list = OpenAI list (MS docs) — codex/nano fall to GENERIC.
  },
};

/** Normalize for matching: lowercase, dash, strip a host id prefix
 *  ("accounts/fireworks/models/…", "openrouter/…", "azure-foundry/…"), drop a
 *  trailing date stamp. Mirrors providers.ts normalizeModelName. */
function normalizeId(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/_/g, "-")
    .split("/").pop()! // drop vendor/host path segments → bare model id
    .replace(/-{2,}/g, "-")
    .replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, "");
}

const TIER = /(^|-)(mini|nano|micro|lite|small|tiny|air|turbo|flash|max|pro|chat)(?=$|-)/;
// Variant/modality words that mean "a different model, not the base" — a
// containment match whose remainder carries one of these is refused outright,
// even when the matched key itself contains a tier word (the bug in #12: a key
// like "…-flash" disabled the old guard, so "…-flash-lite" inherited it). (#12/#21)
const DENY = /(^|-)(lite|distill|audio|realtime|transcribe|tts|vision|image|embed|rerank|deep-research|codex)(?=$|-)/;
/** The tier token a key/remainder carries, if any (for "same tier" comparison). */
function tierTok(s: string): string | undefined {
  return s.match(TIER)?.[2];
}

/** Look up a model's list price, provider-scoped first. Exact normalized match,
 *  then a boundary-anchored containment match (longest key wins so "gpt-5.5-pro"
 *  beats "gpt-5.5"), refusing a containment match across a tier modifier so a
 *  "-mini" never inherits the base price. Returns undefined when nothing fits —
 *  callers keep the honest "$ unknown". Pure. */
export function priceFor(provider: ProviderId | undefined, modelId: string): Price | undefined {
  const id = normalizeId(modelId);
  if (!id) return undefined;
  const scoped = provider ? SCOPED[provider] : undefined;
  // exact match (scoped wins over generic)
  if (scoped?.[id]) return scoped[id];
  if (GENERIC[id]) return GENERIC[id];
  // containment match: the id contains a known family id at a token boundary
  const tables = [scoped, GENERIC].filter(Boolean) as Record<string, Price>[];
  for (const table of tables) {
    const keys = Object.keys(table).sort((a, b) => b.length - a.length);
    for (const key of keys) {
      if (id === key) return table[key];
      // boundary-anchored: "team-gpt-5.4-nano-eastus2" contains "gpt-5.4-nano"
      const re = new RegExp(`(^|[-/])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([-/]|$)`);
      if (!re.test(id)) continue;
      // Don't let a variant inherit the base price. Refuse if the REMAINDER after
      // stripping the key (a) carries a deny-listed modality/variant (lite,
      // distill, audio, codex…), or (b) carries a tier token DIFFERENT from the
      // key's. This holds even when the key itself contains a tier word. (#12/#21)
      const remainder = id.replace(key, "");
      if (DENY.test(remainder)) continue;
      const rt = tierTok(remainder);
      if (rt && rt !== tierTok(key)) continue;
      return table[key];
    }
  }
  return undefined;
}

/** The GENERIC table's keys — exported for the collision guard that asserts none
 *  duplicates a curated model id (would be dead, conflicting data). */
export function genericPriceIds(): string[] {
  return Object.keys(GENERIC);
}

/** The shape estimateCost consumes. */
export function listPriceFor(
  provider: ProviderId | undefined,
  modelId: string,
): { inUSDPerMtok: number; outUSDPerMtok: number } | undefined {
  const p = priceFor(provider, modelId);
  return p ? { inUSDPerMtok: p.in, outUSDPerMtok: p.out } : undefined;
}
