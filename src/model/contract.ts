// THE MODEL REQUEST CONTRACT — correct-by-construction, not self-healing.
//
// Every provider/model has a request contract: which API surface answers it
// (chat vs responses vs messages), what the token-limit param is called, which
// params it rejects, whether the system prompt rides as `system` or `developer`,
// how reasoning is enabled, and whether it can stream. Get any of these wrong
// and the FIRST call fails (the canonical example: Azure codex deployments only
// answer `/responses`, so a chat-completions request returns "The requested
// operation is unsupported.").
//
// This module encodes that contract as DATA — ordered family-pattern rules keyed
// by a regex over the resolved model id — so a new model is correct because it
// matches an existing rule, not because someone hand-wired it. `resolveModel`
// (providers.ts) reads the contract to pick the SDK surface; the request shapers
// read it to drop/rename params. Pure, fixture-tested, no I/O.
//
// Sourcing: the family rules below are encoded from the June-2026 provider
// research in docs/superpowers/specs/2026-06-16-model-contract-registry-design.md
// (OpenAI/Azure reasoning matrix, Anthropic thinking, the OpenAI-compat crowd).
// Volatile data (exact ids, prices) is NOT here — it is discovered + provenance-
// tagged in profiles.ts/discover.ts. Only stable FORMATS and FAMILY RULES live
// here, so the contract does not rot when a vendor ships a new minor version.

import type { ProviderId } from "../providers.ts";

/** Which wire surface the model answers on. */
export type ApiSurface = "chat" | "responses" | "messages" | "converse" | "gemini";

/** Where the system prompt rides. OpenAI reasoning models alias system→developer. */
export type SystemRole = "system" | "developer";

/** How reasoning/thinking is turned on for this family. */
export type ReasoningShape =
  | "openai-effort" // reasoning_effort string (chat) / reasoning.effort (responses)
  | "anthropic-thinking" // top-level thinking + output_config.effort
  | "google-thinking" // generationConfig.thinkingConfig (budget|level)
  | "variant-id" // reasoning selected by the model id itself (grok-4-fast-reasoning)
  | "always-on" // folded in; no param (Fable 5, kimi-k2.7-code)
  | "none";

export interface ReasoningContract {
  shape: ReasoningShape;
  /** Effort levels this family accepts, weakest→strongest. Empty = no effort knob. */
  vocab: string[];
  /** Forced level (gpt-5-pro is always `high` even if unset). */
  force?: string;
  /** Where the reasoning trace comes back, so the harness can strip it before re-send. */
  outputField?: "reasoning_content" | "reasoning" | "thinking" | "think-tag";
}

export interface RequestContract {
  surface: ApiSurface;
  /** Surfaces this model ALSO answers on (for failover/preference). surface is the default. */
  altSurfaces?: ApiSurface[];
  tokenParam: "max_tokens" | "max_completion_tokens" | "max_output_tokens" | "maxOutputTokens" | "maxTokens";
  /** Params to OMIT entirely — sending them is a hard 400 (reasoning models reject sampling). */
  dropParams: string[];
  systemRole: SystemRole;
  reasoning: ReasoningContract;
  /** Clamp temperature into [min,max]; some providers reject values outside their range. */
  tempClamp?: [number, number];
  /** Streaming unsupported — must use a non-streaming call (o1, gpt-5-codex, o3-pro). */
  noStream?: boolean;
  /** Provenance: was this from a matched family rule or a provider default? */
  src: "rule" | "default";
}

// The eight sampling params every OpenAI/Azure reasoning model rejects.
export const OPENAI_REASONING_DROP = [
  "temperature",
  "top_p",
  "presence_penalty",
  "frequency_penalty",
  "logprobs",
  "top_logprobs",
  "logit_bias",
  "max_tokens",
];

type Rule = {
  /** Provider scope; omit to match any provider. */
  providers?: ProviderId[];
  /** Match against the resolved model id (lowercased). */
  test: RegExp;
  contract: Omit<RequestContract, "src">;
};

// OpenAI-surface providers share OpenAI's reasoning contract verbatim (Azure
// confirmed identical in the 2026-06-05 Microsoft matrix). The same families
// reach us through azure, azure-foundry, and the gateways.
const OPENAI_SURFACE: ProviderId[] = ["openai", "azure", "azure-foundry"];

// Ordered: FIRST MATCH WINS. Most specific (codex/pro) before the general
// reasoning families before the non-reasoning default.
const RULES: Rule[] = [
  // ---- OpenAI / Azure: Responses-API-ONLY families -----------------------
  // ORDER MATTERS: the streaming codex line (codex-mini, 5.1+codex) must be
  // tested BEFORE the broader base-codex rule, which would otherwise swallow
  // "codex-mini" and mark it no-stream.
  {
    // codex-mini and the 5.1+ codex line DO stream.
    providers: OPENAI_SURFACE,
    test: /(^|[/-])(codex-mini|gpt-5\.[1-9]\d*-codex(-max|-mini)?)([/-]|$)/,
    contract: {
      surface: "responses",
      tokenParam: "max_output_tokens",
      dropParams: OPENAI_REASONING_DROP,
      systemRole: "developer",
      // gpt-5.1-codex-max adds xhigh.
      reasoning: { shape: "openai-effort", vocab: ["low", "medium", "high", "xhigh"], outputField: "reasoning" },
    },
  },
  {
    // base codex (gpt-5-codex, gpt-5.0-codex, bare "codex"). Responses-only and
    // CANNOT stream.
    providers: OPENAI_SURFACE,
    test: /(^|[/-])(gpt-5(\.0)?-codex|codex)([/-]|$)/,
    contract: {
      surface: "responses",
      tokenParam: "max_output_tokens",
      dropParams: OPENAI_REASONING_DROP,
      systemRole: "developer",
      reasoning: { shape: "openai-effort", vocab: ["low", "medium", "high"], outputField: "reasoning" },
      noStream: true,
    },
  },
  {
    // *-pro (gpt-5-pro, gpt-5.4-pro, o3-pro): Responses-only, effort forced high.
    // o3-pro cannot stream; gpt-5-pro/5.4-pro can.
    providers: OPENAI_SURFACE,
    test: /(^|[/-])o3-pro([/-]|$)/,
    contract: {
      surface: "responses",
      tokenParam: "max_output_tokens",
      dropParams: OPENAI_REASONING_DROP,
      systemRole: "developer",
      reasoning: { shape: "openai-effort", vocab: ["high"], force: "high", outputField: "reasoning" },
      noStream: true,
    },
  },
  {
    providers: OPENAI_SURFACE,
    test: /(^|[/-])gpt-5(\.\d+)?-pro([/-]|$)/,
    contract: {
      surface: "responses",
      tokenParam: "max_output_tokens",
      dropParams: OPENAI_REASONING_DROP,
      systemRole: "developer",
      reasoning: { shape: "openai-effort", vocab: ["high"], force: "high", outputField: "reasoning" },
    },
  },
  // ---- OpenAI / Azure: o-series reasoning (chat, + responses) -------------
  {
    // o1-mini: rejects the `system` role outright, no effort knob, no stream.
    providers: OPENAI_SURFACE,
    test: /(^|[/-])o1-mini([/-]|$)/,
    contract: {
      surface: "chat",
      tokenParam: "max_completion_tokens",
      dropParams: OPENAI_REASONING_DROP,
      systemRole: "developer",
      reasoning: { shape: "none", vocab: [] },
      noStream: true,
    },
  },
  {
    // o1: chat, effort low/med/high, no stream.
    providers: OPENAI_SURFACE,
    test: /(^|[/-])o1([/-]|$)/,
    contract: {
      surface: "chat",
      altSurfaces: ["responses"],
      tokenParam: "max_completion_tokens",
      dropParams: OPENAI_REASONING_DROP,
      systemRole: "developer",
      reasoning: { shape: "openai-effort", vocab: ["low", "medium", "high"], outputField: "reasoning" },
      noStream: true,
    },
  },
  {
    // o3 / o3-mini / o4-mini: chat (+responses), effort low/med/high, stream ok.
    providers: OPENAI_SURFACE,
    test: /(^|[/-])(o3(-mini)?|o4-mini)([/-]|$)/,
    contract: {
      surface: "chat",
      altSurfaces: ["responses"],
      tokenParam: "max_completion_tokens",
      dropParams: OPENAI_REASONING_DROP,
      systemRole: "developer",
      reasoning: { shape: "openai-effort", vocab: ["low", "medium", "high"], outputField: "reasoning" },
    },
  },
  // ---- OpenAI / Azure: gpt-5 family (chat + responses) -------------------
  {
    // gpt-5.1+ : no `minimal`; default `none`. Chat + responses, streams.
    providers: OPENAI_SURFACE,
    test: /(^|[/-])gpt-5\.[1-9]\d*([/-]|$)/,
    contract: {
      surface: "chat",
      altSurfaces: ["responses"],
      tokenParam: "max_completion_tokens",
      dropParams: OPENAI_REASONING_DROP,
      systemRole: "developer",
      reasoning: { shape: "openai-effort", vocab: ["none", "low", "medium", "high"], outputField: "reasoning" },
    },
  },
  {
    // original gpt-5 / 5-mini / 5-nano: `minimal` allowed.
    providers: OPENAI_SURFACE,
    test: /(^|[/-])gpt-5(-mini|-nano)?([/-]|$)/,
    contract: {
      surface: "chat",
      altSurfaces: ["responses"],
      tokenParam: "max_completion_tokens",
      dropParams: OPENAI_REASONING_DROP,
      systemRole: "developer",
      reasoning: { shape: "openai-effort", vocab: ["minimal", "low", "medium", "high"], outputField: "reasoning" },
    },
  },
  // ---- OpenAI / Azure: non-reasoning (gpt-4o, gpt-4.1) -------------------
  {
    providers: OPENAI_SURFACE,
    test: /(^|[/-])(gpt-4o|gpt-4\.1|gpt-4|gpt-3\.?5)([/-]|$)/,
    contract: {
      surface: "chat",
      tokenParam: "max_tokens",
      dropParams: [],
      systemRole: "system",
      reasoning: { shape: "none", vocab: [] },
    },
  },
  // ---- Anthropic (messages API, all routes) -----------------------------
  {
    providers: ["anthropic", "bedrock", "vertex"],
    test: /claude|anthropic/,
    contract: {
      surface: "messages",
      tokenParam: "max_tokens",
      // Fable 5 / Opus 4.8 / 4.7 reject sampling params when thinking is on;
      // we steer by effort, never temperature.
      dropParams: ["top_k"],
      systemRole: "system",
      reasoning: { shape: "anthropic-thinking", vocab: ["low", "medium", "high", "xhigh", "max"], outputField: "thinking" },
    },
  },
  // ---- Google / Vertex (Gemini) -----------------------------------------
  {
    providers: ["google", "vertex"],
    test: /gemini/,
    contract: {
      surface: "gemini",
      tokenParam: "maxOutputTokens",
      dropParams: [],
      systemRole: "system",
      reasoning: { shape: "google-thinking", vocab: ["low", "high"], outputField: "thinking" },
    },
  },
  // ---- DeepSeek-style reasoners served over the OpenAI wire --------------
  {
    test: /(deepseek)?[-/]?r1|deepseek-reasoner|reasoner/,
    contract: {
      surface: "chat",
      tokenParam: "max_tokens",
      // R1-class models reject logprobs when thinking; sampling is ignored.
      dropParams: ["logprobs", "top_logprobs"],
      systemRole: "system",
      reasoning: { shape: "always-on", vocab: [], outputField: "reasoning_content" },
    },
  },
  // ---- xAI grok variant-id reasoning ------------------------------------
  {
    providers: ["xai"],
    test: /grok-.*-(reasoning|non-reasoning)/,
    contract: {
      surface: "chat",
      tokenParam: "max_completion_tokens",
      dropParams: ["presence_penalty", "frequency_penalty", "stop"],
      systemRole: "system",
      reasoning: { shape: "variant-id", vocab: [], outputField: "reasoning_content" },
    },
  },
  {
    providers: ["xai"],
    test: /grok-(3-mini|4\.3)/,
    contract: {
      surface: "chat",
      tokenParam: "max_completion_tokens",
      dropParams: ["presence_penalty", "frequency_penalty", "stop"],
      systemRole: "system",
      reasoning: { shape: "openai-effort", vocab: ["none", "low", "medium", "high"], outputField: "reasoning_content" },
    },
  },
];

// Per-provider DEFAULT contract for any model that matches no family rule. Every
// non-OpenAI/Anthropic provider in the catalog speaks the OpenAI wire on
// /chat/completions with `system` and `max_tokens`; this is the safe baseline.
function defaultFor(provider: ProviderId): Omit<RequestContract, "src"> {
  // Providers whose default token param is max_completion_tokens.
  const maxCompletion = new Set<ProviderId>(["xai", "groq", "cerebras", "nebius"]);
  // Providers that clamp temperature to [0,1] (reject >1).
  const tempClamp: Partial<Record<ProviderId, [number, number]>> = {
    moonshot: [0, 1],
    zai: [0, 1],
    mistral: [0, 0.7],
    together: [0, 1],
  };
  return {
    surface: "chat",
    tokenParam: maxCompletion.has(provider) ? "max_completion_tokens" : "max_tokens",
    dropParams: [],
    systemRole: "system",
    reasoning: { shape: "none", vocab: [] },
    ...(tempClamp[provider] ? { tempClamp: tempClamp[provider] } : {}),
  };
}

/**
 * Resolve the request contract for a (provider, model id). FIRST MATCHING RULE
 * wins; falls back to the provider default. `modelId` should be the model the
 * provider's API actually sees (sdkId / resolved deployment family), NOT a
 * friendly Gearbox id — Azure deployment names are arbitrary, so callers pass
 * the canonical family id (spec.canonicalId ?? spec.sdkId).
 */
export function contractFor(provider: ProviderId, modelId: string): RequestContract {
  const id = (modelId || "").toLowerCase();
  for (const rule of RULES) {
    if (rule.providers && !rule.providers.includes(provider)) continue;
    if (rule.test.test(id)) return { ...rule.contract, src: "rule" };
  }
  return { ...defaultFor(provider), src: "default" };
}

/** True when this model can only be reached via the Responses API. */
export function isResponsesOnly(provider: ProviderId, modelId: string): boolean {
  return contractFor(provider, modelId).surface === "responses";
}
