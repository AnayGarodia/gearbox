// ── MODEL CORPUS ──────────────────────────────────────────────────────────────
// The data foundation for intelligent routing and for accurate context budgeting.
// Each ModelProfile captures everything the router needs to score a candidate:
// context window, pricing (per-Mtok in/out), tokenizer calibration, latency
// (TTFT and tokens/sec), and quality benchmarks (SWE-bench Verified, Artificial
// Analysis intelligence index). Profiles are keyed by the same id used in
// providers.ts, so the router can look up a profile for any registry entry.
//
// Every field carries a provenance tag (measured / researched / seeded) so
// routing code can distinguish a measured benchmark from a best-effort guess.
// This matters for quality gating: the router skips the bar for a seat whose
// quality provenance is unknown rather than penalizing it on a 0.5 assumption.
//
// MEASURED (this machine, 2026-06, experiments/models/): tokenizer calibration
// (vs Anthropic count_tokens + ollama prompt_eval_count) and latency (TTFT, tok/s).
// RESEARCHED (2026-06): SWE-bench Verified, Artificial Analysis intelligence index,
// pricing, see experiments/models/FINDINGS.md for sources.
// SEEDED: best-effort estimates; no primary source available at time of writing.
import type { ProviderId } from "../providers.ts";

export type Provenance = "measured" | "researched" | "seeded";
export type TokenizerFamily = "tiktoken-o200k" | "claude" | "gemini" | "deepseek" | "local" | "llama";

// A complete data record for one model. The router reads cost, latency, and
// quality from here; context budgeting reads contextWindow and tokenizer.
// `id` must match the registry id in providers.ts for the lookup to succeed.
export interface ModelProfile {
  id: string; // matches providers.ts MODELS id where the app uses it
  provider: ProviderId;
  contextWindow: number;
  maxOutput: number;
  // tiktoken(o200k) count * calibration approximates this model's real token count.
  // Claude's subword tokenizer runs 20-40% denser than tiktoken on code, so
  // calibration > 1 gives a safe over-estimate (never overflow context).
  tokenizer: { family: TokenizerFamily; calibration: number; calibrationSrc: Provenance };
  cost: { inUSDPerMtok: number; outUSDPerMtok: number; src: Provenance };
  latency?: { ttftMs: number; tps: number; src: Provenance };
  // Quality benchmarks (LEGACY for routing). The router NO LONGER reads these —
  // its quality source of truth is the researched per-kind corpus in benchmarks.ts
  // (see qualityOf in router.ts). These scalars survive only as a coarse heuristic
  // for classify.ts / policy-nl.ts and the /model list sort; editing them here will
  // NOT change routing decisions. Put real routing-quality numbers in benchmarks.ts.
  quality: { sweBenchVerified?: number; intelligenceIndex?: number; src: Provenance };
  // Expected output tokens as a FRACTION of input tokens for a typical agent
  // turn. Cost estimates that price only the input systematically flatter
  // reasoning-heavy models, whose billed output (visible text + thinking
  // tokens) can run several times a plain model's. Absent → OUTPUT_FACTOR_DEFAULT
  // (0.2: agent turns are input-heavy — big context in, a diff or short answer out).
  outputFactor?: number;
  strengths: string[];
  weaknesses: string[];
  asOf: string; // YYYY-MM snapshot date for these figures
}

// Tokenizer calibration shorthands. The router resolves the calibration once per
// candidate, so these shared constants keep the PROFILES array readable.
// CLAUDE_TOK is measured: code/structured content tokenizes far denser than prose
// in Claude's tokenizer, so 1.35 provides a safe over-estimate.
const CLAUDE_TOK = { family: "claude" as const, calibration: 1.35, calibrationSrc: "measured" as const };
const TIKTOKEN = { family: "tiktoken-o200k" as const, calibration: 1.0, calibrationSrc: "measured" as const };
const GEMINI_TOK = { family: "gemini" as const, calibration: 1.1, calibrationSrc: "seeded" as const };
const DEEPSEEK_TOK = { family: "deepseek" as const, calibration: 1.05, calibrationSrc: "seeded" as const };
const LLAMA_TOK = { family: "llama" as const, calibration: 1.1, calibrationSrc: "seeded" as const };

// Profiles are listed roughly in cost-descending order within each provider tier
// (most capable first). The router does NOT rely on array order; it looks up by
// id. The ordering here is only for human readability.
export const PROFILES: ModelProfile[] = [
  // ── Anthropic ────────────────────────────────────────────────────────────────
  // Three tiers: Opus (quality ceiling), Sonnet (balanced default), Haiku (speed/cost).
  // The quality bar in router.ts maps code/plan tasks to 0.7, which naturally
  // selects Sonnet or above and routes Haiku only to cheap bounded sub-tasks.
  {
    id: "claude-opus-4-8", provider: "anthropic", contextWindow: 1_000_000, maxOutput: 128_000,
    tokenizer: CLAUDE_TOK,
    cost: { inUSDPerMtok: 5, outUSDPerMtok: 25, src: "researched" },
    latency: { ttftMs: 2400, tps: 70, src: "seeded" },
    quality: { sweBenchVerified: 0.83, intelligenceIndex: 64, src: "seeded" },
    // Adaptive thinking bills its reasoning tokens as OUTPUT (Anthropic extended-
    // thinking docs: https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking),
    // and the quality-ceiling tier thinks longest — ~2-3x a plain model's output.
    outputFactor: 0.5,
    strengths: ["most capable", "long-horizon agentic work", "hard multi-step reasoning", "adaptive thinking"],
    weaknesses: ["most expensive", "slower than sonnet/haiku"],
    asOf: "2026-06",
  },
  {
    id: "claude-sonnet-4-6", provider: "anthropic", contextWindow: 1_000_000, maxOutput: 64_000,
    tokenizer: CLAUDE_TOK,
    cost: { inUSDPerMtok: 3, outUSDPerMtok: 15, src: "researched" },
    latency: { ttftMs: 1800, tps: 94, src: "measured" },
    quality: { sweBenchVerified: 0.77, intelligenceIndex: 50, src: "researched" },
    // Adaptive thinking (billed as output) but interleaved/shorter than opus on
    // typical agent turns — modestly above the 0.2 plain-model default.
    outputFactor: 0.35,
    strengths: ["agentic coding", "tool use", "instruction-following", "long-horizon tasks", "adaptive thinking"],
    weaknesses: ["slower + pricier than haiku for simple work"],
    asOf: "2026-06",
  },
  {
    // Haiku: high tps (180) and low cost make it the preferred pick for summarize,
    // classify, and search sub-tasks. The quality bar (0.7 for code) keeps it out
    // of hard tasks even though it is cheapest.
    id: "claude-haiku-4-5", provider: "anthropic", contextWindow: 200_000, maxOutput: 32_000,
    tokenizer: CLAUDE_TOK,
    cost: { inUSDPerMtok: 1, outUSDPerMtok: 5, src: "researched" },
    latency: { ttftMs: 1340, tps: 180, src: "measured" },
    quality: { intelligenceIndex: 38, src: "seeded" },
    strengths: ["fast (approx 2x sonnet throughput)", "cheap", "great for bounded sub-tasks: summarize, classify, search-digest"],
    weaknesses: ["weaker on hard multi-step reasoning vs sonnet/opus"],
    asOf: "2026-06",
  },

  // ── OpenAI ───────────────────────────────────────────────────────────────────
  {
    id: "gpt-5.5", provider: "openai", contextWindow: 400_000, maxOutput: 128_000,
    tokenizer: TIKTOKEN,
    cost: { inUSDPerMtok: 2.5, outUSDPerMtok: 10, src: "seeded" },
    latency: { ttftMs: 0, tps: 0, src: "seeded" },
    quality: { sweBenchVerified: 0.78, intelligenceIndex: 58, src: "seeded" },
    // o-series lineage: reasoning tokens are billed as output (OpenAI reasoning
    // guide, https://platform.openai.com/docs/guides/reasoning — "reasoning tokens
    // ... are billed as output tokens"); at the default medium+ efforts the hidden
    // chain often exceeds the visible answer.
    outputFactor: 0.5,
    strengths: ["strong reasoning (effort: none to xhigh)", "broad knowledge", "tool use"],
    weaknesses: ["pricier output", "reasoning latency at high effort"],
    asOf: "2026-06",
  },

  // ── Google ───────────────────────────────────────────────────────────────────
  // Pro: quality-tier model with 1M context and configurable thinking budget.
  // Flash: cheap/fast with the same 1M context window; good for bulk sub-tasks.
  {
    id: "gemini-3.1-pro-preview", provider: "google", contextWindow: 1_000_000, maxOutput: 64_000,
    tokenizer: GEMINI_TOK,
    cost: { inUSDPerMtok: 2, outUSDPerMtok: 12, src: "seeded" },
    latency: { ttftMs: 0, tps: 0, src: "seeded" },
    quality: { sweBenchVerified: 0.76, intelligenceIndex: 60, src: "seeded" },
    // Gemini thinking variant: thinking tokens are billed at the output rate
    // (https://ai.google.dev/gemini-api/docs/thinking — "thinking tokens ...
    // charged as output"); the pro tier defaults to a generous thinking budget.
    outputFactor: 0.4,
    strengths: ["huge 1M context", "strong reasoning", "thinking config"],
    weaknesses: ["preview", "agentic tool-use historically behind Claude"],
    asOf: "2026-06",
  },
  {
    id: "gemini-3.5-flash", provider: "google", contextWindow: 1_000_000, maxOutput: 64_000,
    tokenizer: GEMINI_TOK,
    cost: { inUSDPerMtok: 0.3, outUSDPerMtok: 2.5, src: "seeded" },
    latency: { ttftMs: 0, tps: 0, src: "seeded" },
    quality: { intelligenceIndex: 48, src: "seeded" },
    strengths: ["very cheap", "fast", "1M context", "thinking config", "good for bulk/grunt sub-tasks"],
    weaknesses: ["lower ceiling on hard tasks"],
    asOf: "2026-06",
  },

  // ── DeepSeek ─────────────────────────────────────────────────────────────────
  // Competitive coding quality at a fraction of frontier prices; smaller context
  // and hosted latency are the trade-offs.
  {
    id: "deepseek-v4-pro", provider: "deepseek", contextWindow: 128_000, maxOutput: 8_000,
    tokenizer: DEEPSEEK_TOK,
    cost: { inUSDPerMtok: 0.4, outUSDPerMtok: 1.75, src: "seeded" },
    latency: { ttftMs: 0, tps: 0, src: "seeded" },
    quality: { sweBenchVerified: 0.81, intelligenceIndex: 55, src: "seeded" },
    // R1/reasoner lineage: DeepSeek's reasoner emits a long visible CoT billed as
    // output — historically the chattiest of the reasoning models (R1 averaged
    // thousands of CoT tokens per answer; https://api-docs.deepseek.com/quick_start/pricing).
    outputFactor: 0.6,
    strengths: ["far cheaper than frontier", "strong coding for the price", "reasoning"],
    weaknesses: ["smaller context", "slower hosted latency"],
    asOf: "2026-06",
  },

  // ── Amazon Bedrock ───────────────────────────────────────────────────────────
  // Claude models via Bedrock carry approximately 10% pricing premium over
  // Anthropic direct (cross-region inference pricing). AWS-native deployment
  // removes the need for API keys outside AWS and enables VPC endpoints.
  {
    id: "bedrock/anthropic.claude-sonnet-4-20250514-v1:0", provider: "bedrock", contextWindow: 200_000, maxOutput: 64_000,
    tokenizer: CLAUDE_TOK,
    cost: { inUSDPerMtok: 3.3, outUSDPerMtok: 16.5, src: "seeded" },
    latency: { ttftMs: 1900, tps: 90, src: "seeded" },
    quality: { sweBenchVerified: 0.77, intelligenceIndex: 50, src: "seeded" },
    outputFactor: 0.35, // same thinking Sonnet as the anthropic-direct entry
    strengths: ["agentic coding", "tool use", "instruction-following", "AWS-native deployment", "extended thinking"],
    weaknesses: ["10% pricier than Anthropic direct", "Bedrock model enablement required"],
    asOf: "2026-06",
  },
  {
    id: "bedrock/anthropic.claude-haiku-4-5-20251001-v1:0", provider: "bedrock", contextWindow: 200_000, maxOutput: 32_000,
    tokenizer: CLAUDE_TOK,
    cost: { inUSDPerMtok: 1.1, outUSDPerMtok: 5.5, src: "seeded" },
    latency: { ttftMs: 1400, tps: 170, src: "seeded" },
    quality: { intelligenceIndex: 38, src: "seeded" },
    strengths: ["fast", "cheap", "AWS-native", "good for bounded sub-tasks"],
    weaknesses: ["weaker on hard reasoning", "10% premium over Anthropic direct"],
    asOf: "2026-06",
  },
  {
    id: "bedrock/anthropic.claude-opus-4-20250514-v1:0", provider: "bedrock", contextWindow: 200_000, maxOutput: 128_000,
    tokenizer: CLAUDE_TOK,
    cost: { inUSDPerMtok: 5.5, outUSDPerMtok: 27.5, src: "seeded" },
    latency: { ttftMs: 2500, tps: 65, src: "seeded" },
    quality: { sweBenchVerified: 0.83, intelligenceIndex: 64, src: "seeded" },
    outputFactor: 0.5, // same thinking Opus as the anthropic-direct entry
    strengths: ["most capable", "long-horizon agentic work", "AWS-native deployment", "extended thinking"],
    weaknesses: ["most expensive", "slower", "10% premium over Anthropic direct"],
    asOf: "2026-06",
  },
  {
    // Nova Pro: Amazon's own multimodal model. Lower quality ceiling than Claude
    // but native to AWS and cheaper for bulk work.
    id: "bedrock/amazon.nova-pro-v1:0", provider: "bedrock", contextWindow: 300_000, maxOutput: 5_000,
    tokenizer: TIKTOKEN,
    cost: { inUSDPerMtok: 0.8, outUSDPerMtok: 3.2, src: "seeded" },
    latency: { ttftMs: 0, tps: 0, src: "seeded" },
    quality: { intelligenceIndex: 42, src: "seeded" },
    strengths: ["native AWS model", "multimodal (text+image+video)", "large context", "reasonable price"],
    weaknesses: ["weaker than Claude on hard coding/reasoning"],
    asOf: "2026-06",
  },
  {
    id: "bedrock/amazon.nova-lite-v1:0", provider: "bedrock", contextWindow: 300_000, maxOutput: 5_000,
    tokenizer: TIKTOKEN,
    cost: { inUSDPerMtok: 0.06, outUSDPerMtok: 0.24, src: "seeded" },
    latency: { ttftMs: 0, tps: 0, src: "seeded" },
    quality: { intelligenceIndex: 32, src: "seeded" },
    strengths: ["very cheap", "native AWS", "large context", "good for bulk tasks"],
    weaknesses: ["lower ceiling on complex tasks"],
    asOf: "2026-06",
  },
  {
    id: "bedrock/amazon.nova-micro-v1:0", provider: "bedrock", contextWindow: 128_000, maxOutput: 5_000,
    tokenizer: TIKTOKEN,
    cost: { inUSDPerMtok: 0.035, outUSDPerMtok: 0.14, src: "seeded" },
    latency: { ttftMs: 0, tps: 0, src: "seeded" },
    quality: { intelligenceIndex: 25, src: "seeded" },
    strengths: ["cheapest AWS model", "text-only, fast", "classify/summarize"],
    weaknesses: ["no image input", "lower quality ceiling"],
    asOf: "2026-06",
  },
  {
    id: "bedrock/meta.llama4-maverick-17b-instruct-v1:0", provider: "bedrock", contextWindow: 128_000, maxOutput: 8_000,
    tokenizer: LLAMA_TOK,
    cost: { inUSDPerMtok: 0.24, outUSDPerMtok: 0.97, src: "seeded" },
    latency: { ttftMs: 0, tps: 0, src: "seeded" },
    quality: { intelligenceIndex: 44, src: "seeded" },
    strengths: ["multimodal (text+image)", "competitive quality per dollar", "AWS-native"],
    weaknesses: ["smaller context than Nova", "OSS model quality ceiling"],
    asOf: "2026-06",
  },
  {
    id: "bedrock/meta.llama4-scout-17b-instruct-v1:0", provider: "bedrock", contextWindow: 128_000, maxOutput: 8_000,
    tokenizer: LLAMA_TOK,
    cost: { inUSDPerMtok: 0.17, outUSDPerMtok: 0.66, src: "seeded" },
    latency: { ttftMs: 0, tps: 0, src: "seeded" },
    quality: { intelligenceIndex: 38, src: "seeded" },
    strengths: ["cheap", "fast", "multimodal", "AWS-native"],
    weaknesses: ["lower quality than Maverick", "OSS model quality ceiling"],
    asOf: "2026-06",
  },

  // ── Google Vertex AI ─────────────────────────────────────────────────────────
  // The same Gemini model family as the google provider, deployed on GCP Vertex.
  // Pricing may differ from the public API depending on committed-use discounts.
  {
    id: "vertex/gemini-3.1-pro-preview", provider: "vertex", contextWindow: 1_000_000, maxOutput: 64_000,
    tokenizer: GEMINI_TOK,
    cost: { inUSDPerMtok: 2, outUSDPerMtok: 12, src: "seeded" },
    latency: { ttftMs: 0, tps: 0, src: "seeded" },
    quality: { sweBenchVerified: 0.76, intelligenceIndex: 60, src: "seeded" },
    outputFactor: 0.4, // same Gemini pro thinking model as the google entry above
    strengths: ["1M context", "strong reasoning", "thinking config", "GCP-native deployment"],
    weaknesses: ["preview", "agentic tool-use behind Claude"],
    asOf: "2026-06",
  },
  {
    id: "vertex/gemini-3.5-flash", provider: "vertex", contextWindow: 1_000_000, maxOutput: 64_000,
    tokenizer: GEMINI_TOK,
    cost: { inUSDPerMtok: 0.3, outUSDPerMtok: 2.5, src: "seeded" },
    latency: { ttftMs: 0, tps: 0, src: "seeded" },
    quality: { intelligenceIndex: 48, src: "seeded" },
    strengths: ["very cheap", "fast", "1M context", "thinking config", "GCP-native"],
    weaknesses: ["lower ceiling on hard tasks"],
    asOf: "2026-06",
  },
  {
    id: "vertex/gemini-3.1-flash-lite", provider: "vertex", contextWindow: 1_000_000, maxOutput: 8_000,
    tokenizer: GEMINI_TOK,
    cost: { inUSDPerMtok: 0.1, outUSDPerMtok: 0.4, src: "seeded" },
    latency: { ttftMs: 0, tps: 0, src: "seeded" },
    quality: { intelligenceIndex: 30, src: "seeded" },
    strengths: ["cheapest Vertex model", "1M context", "fast", "classify/summarize"],
    weaknesses: ["no thinking config", "lower quality ceiling"],
    asOf: "2026-06",
  },
];

// Fast O(1) lookup used by the router and context-budgeting code. Built once at
// module load time; never mutated at runtime.
const BY_ID = new Map(PROFILES.map((p) => [p.id, p]));
export function profileFor(id: string): ModelProfile | undefined {
  return BY_ID.get(id);
}

// ── Output factor ─────────────────────────────────────────────────────────────
// Plain (non-reasoning) agent turns are input-heavy: a large assembled context in,
// a diff or short answer out — output runs ~1/5 of input on typical turns, so 0.2
// is the conservative default for any model without a measured/researched override.
export const OUTPUT_FACTOR_DEFAULT = 0.2;

// Expected output tokens as a fraction of input for an agent turn. Pure lookup:
// the profile's override (set for reasoning-heavy models whose billed output
// includes thinking tokens) or the plain-model default. Unknown ids get the
// default too — same philosophy as PROVIDER_CALIBRATION's safe fallback.
export function outputFactorFor(modelId: string): number {
  return BY_ID.get(modelId)?.outputFactor ?? OUTPUT_FACTOR_DEFAULT;
}

// ── Prompt-cache economics ────────────────────────────────────────────────────
// Fraction of the NORMAL input price charged for CACHE-READ tokens, per provider.
// The scorer multiplies the expected cached share of input by this to stop the
// cost estimate from overcharging providers with cheap cache reads. null = the
// provider exposes no prompt caching (the scorer treats every input token as
// full-price). Verified against official pricing pages, 2026-06:
//   anthropic: cache reads cost 10% of base input (cache writes +25%) —
//     https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
//   openai:    cached input is 10% of base for current models (gpt-5 family:
//     $0.125 vs $1.25/Mtok — https://platform.openai.com/docs/pricing); the older
//     4o-era 50% discount is deliberately NOT used here.
//   deepseek:  cache HIT price is ~10% of the miss price, automatic, no write fee —
//     https://api-docs.deepseek.com/quick_start/pricing
//   google/vertex: implicit caching bills cached tokens at 25% of input
//     (https://ai.google.dev/gemini-api/docs/caching); explicit caches add a
//     per-hour storage fee we don't model here.
//   bedrock:   Claude prompt caching on Bedrock mirrors Anthropic's 10% reads —
//     https://aws.amazon.com/bedrock/pricing/
const CACHE_READ_DISCOUNT: Record<string, number> = {
  anthropic: 0.1,
  openai: 0.1,
  deepseek: 0.1,
  google: 0.25,
  vertex: 0.25,
  bedrock: 0.1,
};

// null (not 1.0) for an unknown provider: the scorer reads null as "no caching",
// which is the honest neutral — we'd rather slightly overestimate cost than
// invent a discount a provider never grants.
export function cacheReadDiscount(provider: string): number | null {
  return CACHE_READ_DISCOUNT[provider] ?? null;
}

// Per-provider calibration fallback: used when a model id is not in PROFILES
// (e.g. a future model added to providers.ts before a profile is written).
// Conservative over-estimates are safe; under-estimates risk context overflow.
export const PROVIDER_CALIBRATION: Record<ProviderId, number> = {
  anthropic: 1.35,
  openai: 1.0,
  google: 1.1,
  deepseek: 1.05,
  bedrock: 1.35,  // Claude-dominated; conservative for Nova/Llama
  vertex: 1.1,    // Gemini models, same as google native
};
