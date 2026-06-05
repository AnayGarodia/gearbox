// Map a model-specific reasoning effort to providerOptions. Effort is not a
// global 3-level knob: providers and even individual models expose different
// values (`xhigh` on OpenAI, `max` on Anthropic, etc.). Keep the supported list
// on ModelSpec and only emit a provider option when the chosen model advertises
// the exact effort.
import type { ModelSpec } from "../providers.ts";

export type Effort = string;

const OPENAI_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"];
const ANTHROPIC_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const GOOGLE_EFFORTS = ["minimal", "low", "medium", "high"];

export function effortLevels(spec: ModelSpec): string[] {
  if (spec.efforts) return spec.efforts;
  if (!spec.reasoning) return [];
  if (spec.provider === "openai") return OPENAI_EFFORTS;
  if (spec.provider === "anthropic") return ANTHROPIC_EFFORTS;
  if (spec.provider === "google" || spec.provider === "vertex") return GOOGLE_EFFORTS;
  return [];
}

export function normalizeEffort(input: string, allowed: string[]): string | null {
  const q = input.trim().toLowerCase().replace(/[\s_-]+/g, "");
  const aliases: Record<string, string> = {
    fast: "low",
    balanced: "medium",
    default: "medium",
    extra: "xhigh",
    extrahigh: "xhigh",
    extraheavy: "xhigh",
  };
  const wanted = aliases[q] ?? q;
  return allowed.find((e) => e.toLowerCase().replace(/[\s_-]+/g, "") === wanted) ?? null;
}

export function reasoningOptions(spec: ModelSpec, effort: Effort): Record<string, unknown> {
  const level = normalizeEffort(effort, effortLevels(spec));
  if (!level) return {};
  const p = spec.provider;
  if (p === "openai") {
    return { openai: { reasoningEffort: level } };
  }
  if (p === "google" || p === "vertex") {
    return { google: { thinkingConfig: { thinkingLevel: level } } };
  }
  if (p === "anthropic") {
    return { anthropic: { effort: level } };
  }
  // Other providers (openai-compat, deepseek, etc.) reason by their own defaults;
  // we don't inject an unsupported param.
  return {};
}
