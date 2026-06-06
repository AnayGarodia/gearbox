// MODEL CORPUS — the data foundation for intelligent routing and for accurate
// context budgeting. Per model: context window, cost, tokenizer calibration,
// latency, quality, and qualitative strengths/weaknesses. Every field is tagged
// by provenance (measured here / researched / seeded) and dated — routing must
// know a benchmark guess from a measured fact (DESIGN.md: confidence is first-class).
//
// MEASURED (this machine, 2026-06, experiments/models/): tokenizer calibration
// (vs Anthropic count_tokens + ollama prompt_eval_count) and latency (TTFT, tok/s).
// RESEARCHED (2026-06): SWE-bench Verified, Artificial Analysis intelligence index,
// pricing — see experiments/models/FINDINGS.md for sources. SEEDED: best-effort.
import type { ProviderId } from "../providers.ts";

export type Provenance = "measured" | "researched" | "seeded";
export type TokenizerFamily = "tiktoken-o200k" | "claude" | "gemini" | "deepseek" | "local" | "llama";

export interface ModelProfile {
  id: string; // matches providers.ts MODELS id where the app uses it
  provider: ProviderId;
  contextWindow: number;
  maxOutput: number;
  // tiktoken(o200k) count × calibration ≈ this model's real token count.
  // Calibration measured against Anthropic /v1/messages/count_tokens & ollama.
  tokenizer: { family: TokenizerFamily; calibration: number; calibrationSrc: Provenance };
  cost: { inUSDPerMtok: number; outUSDPerMtok: number; src: Provenance };
  latency?: { ttftMs: number; tps: number; src: Provenance };
  quality: { sweBenchVerified?: number; intelligenceIndex?: number; src: Provenance };
  strengths: string[];
  weaknesses: string[];
  asOf: string;
}

// Tokenizer calibration is MEASURED: code/structured content tokenizes far denser
// than prose, and Claude runs ~20–40% above tiktoken — so we over-estimate slightly
// (safe: never overflow). Anthropic exact counts are available free via count_tokens.
const CLAUDE_TOK = { family: "claude" as const, calibration: 1.35, calibrationSrc: "measured" as const };
const TIKTOKEN = { family: "tiktoken-o200k" as const, calibration: 1.0, calibrationSrc: "measured" as const };
const GEMINI_TOK = { family: "gemini" as const, calibration: 1.1, calibrationSrc: "seeded" as const };
const DEEPSEEK_TOK = { family: "deepseek" as const, calibration: 1.05, calibrationSrc: "seeded" as const };
const LLAMA_TOK = { family: "llama" as const, calibration: 1.1, calibrationSrc: "seeded" as const };

export const PROFILES: ModelProfile[] = [
  {
    id: "claude-opus-4-8", provider: "anthropic", contextWindow: 1_000_000, maxOutput: 128_000,
    tokenizer: CLAUDE_TOK,
    cost: { inUSDPerMtok: 5, outUSDPerMtok: 25, src: "researched" },
    latency: { ttftMs: 2400, tps: 70, src: "seeded" },
    quality: { sweBenchVerified: 0.83, intelligenceIndex: 64, src: "seeded" },
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
    strengths: ["agentic coding", "tool use", "instruction-following", "long-horizon tasks", "adaptive thinking"],
    weaknesses: ["slower + pricier than haiku for simple work"],
    asOf: "2026-06",
  },
  {
    id: "claude-haiku-4-5", provider: "anthropic", contextWindow: 200_000, maxOutput: 32_000,
    tokenizer: CLAUDE_TOK,
    cost: { inUSDPerMtok: 1, outUSDPerMtok: 5, src: "researched" },
    latency: { ttftMs: 1340, tps: 180, src: "measured" },
    quality: { intelligenceIndex: 38, src: "seeded" },
    strengths: ["fast (≈2× sonnet throughput)", "cheap", "great for bounded sub-tasks: summarize, classify, search-digest"],
    weaknesses: ["weaker on hard multi-step reasoning vs sonnet/opus"],
    asOf: "2026-06",
  },
  {
    id: "gpt-5.5", provider: "openai", contextWindow: 400_000, maxOutput: 128_000,
    tokenizer: TIKTOKEN,
    cost: { inUSDPerMtok: 2.5, outUSDPerMtok: 10, src: "seeded" },
    latency: { ttftMs: 0, tps: 0, src: "seeded" },
    quality: { sweBenchVerified: 0.78, intelligenceIndex: 58, src: "seeded" },
    strengths: ["strong reasoning (effort: none→xhigh)", "broad knowledge", "tool use"],
    weaknesses: ["pricier output", "reasoning latency at high effort"],
    asOf: "2026-06",
  },
  {
    id: "gemini-3.1-pro-preview", provider: "google", contextWindow: 1_000_000, maxOutput: 64_000,
    tokenizer: GEMINI_TOK,
    cost: { inUSDPerMtok: 2, outUSDPerMtok: 12, src: "seeded" },
    latency: { ttftMs: 0, tps: 0, src: "seeded" },
    quality: { sweBenchVerified: 0.76, intelligenceIndex: 60, src: "seeded" },
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
  {
    id: "deepseek-v4-pro", provider: "deepseek", contextWindow: 128_000, maxOutput: 8_000,
    tokenizer: DEEPSEEK_TOK,
    cost: { inUSDPerMtok: 0.4, outUSDPerMtok: 1.75, src: "seeded" },
    latency: { ttftMs: 0, tps: 0, src: "seeded" },
    quality: { sweBenchVerified: 0.81, intelligenceIndex: 55, src: "seeded" },
    strengths: ["far cheaper than frontier", "strong coding for the price", "reasoning"],
    weaknesses: ["smaller context", "slower hosted latency"],
    asOf: "2026-06",
  },

  // ── Amazon Bedrock ───────────────────────────────────────────────────────────
  // Claude models via Bedrock carry ~10% pricing premium over Anthropic direct.
  {
    id: "bedrock/anthropic.claude-sonnet-4-20250514-v1:0", provider: "bedrock", contextWindow: 200_000, maxOutput: 64_000,
    tokenizer: CLAUDE_TOK,
    cost: { inUSDPerMtok: 3.3, outUSDPerMtok: 16.5, src: "seeded" },
    latency: { ttftMs: 1900, tps: 90, src: "seeded" },
    quality: { sweBenchVerified: 0.77, intelligenceIndex: 50, src: "seeded" },
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
    strengths: ["most capable", "long-horizon agentic work", "AWS-native deployment", "extended thinking"],
    weaknesses: ["most expensive", "slower", "10% premium over Anthropic direct"],
    asOf: "2026-06",
  },
  {
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
  // Same Gemini models as google native; pricing may vary by project/committed use.
  {
    id: "vertex/gemini-3.1-pro-preview", provider: "vertex", contextWindow: 1_000_000, maxOutput: 64_000,
    tokenizer: GEMINI_TOK,
    cost: { inUSDPerMtok: 2, outUSDPerMtok: 12, src: "seeded" },
    latency: { ttftMs: 0, tps: 0, src: "seeded" },
    quality: { sweBenchVerified: 0.76, intelligenceIndex: 60, src: "seeded" },
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

const BY_ID = new Map(PROFILES.map((p) => [p.id, p]));
export function profileFor(id: string): ModelProfile | undefined {
  return BY_ID.get(id);
}

// Tokenizer calibration by provider (fallback when a model id isn't profiled).
export const PROVIDER_CALIBRATION: Record<ProviderId, number> = {
  anthropic: 1.35,
  openai: 1.0,
  google: 1.1,
  deepseek: 1.05,
  bedrock: 1.35,  // Claude-dominated; conservative for Nova/Llama
  vertex: 1.1,    // Gemini models, same as google native
};
