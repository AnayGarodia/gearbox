// Map an effort tier to per-provider reasoning/thinking controls, as AI SDK
// `providerOptions`. Effort is the user-facing knob (fast · balanced · max); each
// provider exposes reasoning differently, so this is the translation layer.
// Only emitted for models that advertise `reasoning` (providers.ts ModelSpec) —
// passing a reasoning param to a model that doesn't support it can 400, so we
// stay conservative and only use documented shapes.
import type { ModelSpec } from "../providers.ts";

export type Effort = "fast" | "balanced" | "max";

// OpenAI reasoning effort (none/minimal/low/medium/high/xhigh). We map the three
// tiers to the safe middle of that range.
const OPENAI_EFFORT: Record<Effort, string> = { fast: "low", balanced: "medium", max: "high" };
// Google thinkingConfig.thinkingLevel.
const GOOGLE_LEVEL: Record<Effort, string> = { fast: "low", balanced: "medium", max: "high" };

export function reasoningOptions(spec: ModelSpec, effort: Effort): Record<string, unknown> {
  if (!spec.reasoning) return {};
  const p = spec.provider;
  if (p === "openai") {
    return { openai: { reasoningEffort: OPENAI_EFFORT[effort] } };
  }
  if (p === "google" || p === "vertex") {
    return { google: { thinkingConfig: { thinkingLevel: GOOGLE_LEVEL[effort] } } };
  }
  if (p === "anthropic") {
    // Claude 4.7+ uses adaptive thinking by default; only nudge it up at max
    // (and leave it to answer fast at the fast tier).
    return effort === "max" ? { anthropic: { thinking: { type: "adaptive" } } } : {};
  }
  // Other providers (openai-compat, deepseek, etc.) reason by their own defaults;
  // we don't inject an unsupported param.
  return {};
}
