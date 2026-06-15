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
  | "thinking-toggle" // provider-native thinking:{type:enabled|disabled|adaptive} object (deepseek-v4, kimi-k2.6, glm, minimax-m3)
  | "think-tag" // reasoning emitted inline as <think>…</think>, no enable param (hyperbolic, sambanova R1, perplexity sonar-reasoning, local)
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
  {
    // grok-code-fast clamps temperature to [0,1] (docs.x.ai).
    providers: ["xai"],
    test: /grok-code-fast/,
    contract: {
      surface: "chat",
      tokenParam: "max_completion_tokens",
      dropParams: [],
      systemRole: "system",
      reasoning: { shape: "always-on", vocab: [], outputField: "reasoning_content" },
      tempClamp: [0, 1],
    },
  },
  // ---- DeepSeek V4 (thinking-toggle, distinct from the R1 always-on rule) -
  {
    providers: ["deepseek"],
    test: /deepseek-v4/,
    contract: {
      surface: "chat",
      tokenParam: "max_tokens",
      dropParams: [],
      systemRole: "system",
      // V4: extra_body.thinking.type enabled|disabled + reasoning_effort high|max.
      reasoning: { shape: "thinking-toggle", vocab: ["high", "max"], outputField: "reasoning_content" },
      tempClamp: [0, 2],
    },
  },
  // ---- Moonshot Kimi (thinking-toggle; k2.7-code always-on; temp 0-1) ------
  {
    providers: ["moonshot"],
    test: /kimi-k2\.7-code/,
    contract: {
      surface: "chat",
      tokenParam: "max_tokens",
      dropParams: ["temperature"], // k2.7-code: thinking always-on, omit temperature (platform.kimi.ai)
      systemRole: "system",
      reasoning: { shape: "always-on", vocab: [], outputField: "reasoning_content" },
      tempClamp: [0, 1],
    },
  },
  {
    providers: ["moonshot"],
    test: /kimi-k2\.[56]/,
    contract: {
      surface: "chat",
      tokenParam: "max_tokens",
      dropParams: [],
      systemRole: "system",
      reasoning: { shape: "thinking-toggle", vocab: [], outputField: "reasoning_content" },
      tempClamp: [0, 1],
    },
  },
  // ---- Z.ai GLM (nested thinking:{type,clear_thinking}; temp 0-1) ----------
  {
    providers: ["zai"],
    test: /glm-/,
    contract: {
      surface: "chat",
      tokenParam: "max_tokens",
      dropParams: [],
      systemRole: "system",
      reasoning: { shape: "thinking-toggle", vocab: [], outputField: "reasoning_content" },
      tempClamp: [0, 1],
    },
  },
  // ---- MiniMax (thinking:{type:adaptive|disabled}; base_resp-in-200) -------
  {
    providers: ["minimax"],
    test: /minimax/,
    contract: {
      surface: "chat",
      tokenParam: "max_completion_tokens",
      dropParams: [],
      systemRole: "system",
      reasoning: { shape: "thinking-toggle", vocab: [], outputField: "reasoning_content" },
      tempClamp: [0, 2],
    },
  },
  // ---- Mistral Magistral (reasoning by id, [THINK] tokens; strict params) --
  {
    providers: ["mistral"],
    test: /magistral/,
    contract: {
      surface: "chat",
      tokenParam: "max_tokens",
      // Mistral 422s on unknown params; penalties commonly rejected.
      dropParams: ["presence_penalty", "frequency_penalty", "n"],
      systemRole: "system",
      reasoning: { shape: "variant-id", vocab: ["none", "high"], outputField: "think-tag" },
      tempClamp: [0, 0.7],
    },
  },
  // ---- Groq: reasoning_effort families; strips logprobs/penalty/n ----------
  {
    providers: ["groq"],
    test: /gpt-oss|qwen.?3/,
    contract: {
      surface: "chat",
      tokenParam: "max_completion_tokens",
      dropParams: ["logprobs", "top_logprobs", "logit_bias", "n"],
      systemRole: "system",
      reasoning: { shape: "openai-effort", vocab: ["low", "medium", "high"], outputField: "reasoning_content" },
    },
  },
  // ---- Perplexity Sonar reasoning (inline <think>; tools unsupported) ------
  {
    providers: ["perplexity"],
    test: /sonar-reasoning|r1-1776/,
    contract: {
      surface: "chat",
      tokenParam: "max_tokens",
      dropParams: ["tools", "tool_choice", "logit_bias", "n", "seed"],
      systemRole: "system",
      reasoning: { shape: "think-tag", vocab: [], outputField: "think-tag" },
      tempClamp: [0, 2],
    },
  },
  // ---- Generic R1/Qwen reasoners on inference hosts emit inline <think> ----
  {
    providers: ["hyperbolic", "sambanova", "together", "baseten", "novita", "deepinfra", "nebius", "fireworks", "ollama", "lmstudio", "llamacpp", "vllm"],
    test: /r1|qwen.?3|deepseek-r|qwq/,
    contract: {
      surface: "chat",
      tokenParam: "max_tokens",
      dropParams: [],
      systemRole: "system",
      reasoning: { shape: "think-tag", vocab: [], outputField: "think-tag" },
    },
  },
];

// Per-provider DEFAULT contract for any model that matches no family rule, keyed
// to each provider's DOCUMENTED baseline (token param, temperature range, system
// role). Every non-native provider speaks the OpenAI wire on /chat/completions;
// the differences below are what the docs actually specify and what trips a
// first call. Sourced from the June-2026 per-provider research (see the design
// doc). A provider absent here gets the universal safe baseline.
type ProviderDefault = {
  tokenParam: RequestContract["tokenParam"];
  systemRole?: SystemRole; // default "system"
  tempClamp?: [number, number];
};

const PROVIDER_DEFAULTS: Partial<Record<ProviderId, ProviderDefault>> = {
  // OpenAI-surface (reasoning families handled by rules above; this is the
  // non-reasoning baseline).
  openai: { tokenParam: "max_tokens" },
  azure: { tokenParam: "max_tokens" },
  "azure-foundry": { tokenParam: "max_tokens" },
  // Native Chinese-lab APIs (OpenAI-compatible) — documented temp ranges differ.
  deepseek: { tokenParam: "max_tokens", tempClamp: [0, 2] }, // api-docs.deepseek.com
  moonshot: { tokenParam: "max_tokens", tempClamp: [0, 1] }, // platform.kimi.ai (/v1 range 0-1)
  zai: { tokenParam: "max_tokens", tempClamp: [0, 1] }, // docs.z.ai (>1 → error 1214)
  minimax: { tokenParam: "max_completion_tokens", tempClamp: [0, 2] }, // platform.minimax.io
  // Frontier API providers.
  xai: { tokenParam: "max_completion_tokens", tempClamp: [0, 2] }, // docs.x.ai
  mistral: { tokenParam: "max_tokens", tempClamp: [0, 0.7] }, // docs.mistral.ai (clamp ≤0.7; strict 422 on unknown params)
  groq: { tokenParam: "max_completion_tokens", tempClamp: [0, 2] }, // console.groq.com
  cerebras: { tokenParam: "max_completion_tokens", tempClamp: [0, 2] }, // inference-docs.cerebras.ai (also accepts developer)
  perplexity: { tokenParam: "max_tokens", tempClamp: [0, 2] }, // docs.perplexity.ai
  // Aggregators / gateways (OpenAI-shaped passthrough; they normalize per-model).
  openrouter: { tokenParam: "max_tokens" },
  "vercel-gateway": { tokenParam: "max_tokens" },
  portkey: { tokenParam: "max_tokens" },
  requesty: { tokenParam: "max_tokens" },
  litellm: { tokenParam: "max_tokens" },
  // Open-weight inference hosts (OpenAI-compatible; HF-style ids).
  fireworks: { tokenParam: "max_tokens", tempClamp: [0, 2] }, // docs.fireworks.ai
  together: { tokenParam: "max_tokens", tempClamp: [0, 1] }, // docs.together.ai (narrower 0-1)
  deepinfra: { tokenParam: "max_tokens", tempClamp: [0, 2] }, // docs.deepinfra.com (16384 output cap)
  baseten: { tokenParam: "max_tokens", tempClamp: [0, 2] }, // docs.baseten.co (bare-string error envelope)
  hyperbolic: { tokenParam: "max_tokens", tempClamp: [0, 2] }, // hyperbolic.ai/docs
  nebius: { tokenParam: "max_completion_tokens", tempClamp: [0, 2] }, // api.tokenfactory.nebius.com (FastAPI detail envelope)
  novita: { tokenParam: "max_tokens", tempClamp: [0, 2] }, // api.novita.ai (lowercase vendor/model ids)
  sambanova: { tokenParam: "max_tokens", tempClamp: [0, 2] }, // docs.sambanova.ai (also accepts developer; penalties ignored)
  // Local / self-hosted runtimes — cost $0; ids discovered, not cataloged.
  ollama: { tokenParam: "max_tokens" }, // /v1 maps to num_predict; default ctx 4096
  lmstudio: { tokenParam: "max_tokens" },
  llamacpp: { tokenParam: "max_tokens" }, // n_predict
  vllm: { tokenParam: "max_completion_tokens" }, // docs.vllm.ai (max_tokens alias)
};

function defaultFor(provider: ProviderId): Omit<RequestContract, "src"> {
  const d = PROVIDER_DEFAULTS[provider];
  return {
    surface: "chat",
    tokenParam: d?.tokenParam ?? "max_tokens",
    dropParams: [],
    systemRole: d?.systemRole ?? "system",
    reasoning: { shape: "none", vocab: [] },
    ...(d?.tempClamp ? { tempClamp: d.tempClamp } : {}),
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
