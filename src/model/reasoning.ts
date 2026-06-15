// Map a model-specific reasoning effort to providerOptions. Effort is not a
// global 3-level knob: providers and even individual models expose different
// values (`xhigh` on OpenAI, `max` on Anthropic, etc.). Keep the supported list
// on ModelSpec and only emit a provider option when the chosen model advertises
// the exact effort.
import type { ModelSpec } from "../providers.ts";
import { contractFor } from "./contract.ts";

export type Effort = string;

const OPENAI_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"];
const ANTHROPIC_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const GOOGLE_EFFORTS = ["minimal", "low", "medium", "high"];

// Canonical ordering weakest to strongest, used to find the nearest valid level when clamping.
export const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Clamp `current` to the nearest level in `allowed`. Returns `current` if already valid,
 * the closest (by EFFORT_ORDER position) allowed level otherwise, or "medium" if allowed is empty.
 */
export function clampEffort(current: string, allowed: string[]): { level: string; clamped: boolean } {
  if (!allowed.length) return { level: "medium", clamped: current !== "medium" };
  if (allowed.includes(current)) return { level: current, clamped: false };
  const idx = EFFORT_ORDER.indexOf(current);
  // Walk outward from the current position, checking higher then lower, to find the closest allowed level.
  for (let d = 1; d <= EFFORT_ORDER.length; d++) {
    const hi = EFFORT_ORDER[idx + d];
    if (hi && allowed.includes(hi)) return { level: hi, clamped: true };
    const lo = EFFORT_ORDER[idx - d];
    if (lo && allowed.includes(lo)) return { level: lo, clamped: true };
  }
  return { level: allowed[allowed.length - 1]!, clamped: true };
}

export function effortLevels(spec: ModelSpec): string[] {
  if (spec.efforts) return spec.efforts;
  // A spec the registry marks non-reasoning gets no effort knob, period (Haiku
  // 4.5, gpt-4o, …) — gate before consulting the contract.
  if (!spec.reasoning) return [];
  // The per-model request contract carries the DOCUMENTED effort vocabulary per
  // family (e.g. o3 = low/med/high only, gpt-5-pro forces high, base gpt-5 adds
  // minimal). Prefer it over the coarse provider-wide default below — this is
  // what makes a discovered/generated reasoning model (no curated `efforts`)
  // clamp to the levels its docs actually accept, not the whole provider superset.
  const vocab = contractFor(spec.provider, spec.canonicalId ?? spec.sdkId).reasoning.vocab;
  if (vocab.length) return vocab;
  if (spec.provider === "openai") return OPENAI_EFFORTS;
  // Azure OpenAI mirrors the OpenAI reasoning API (reasoningEffort param, same level names).
  if (spec.provider === "azure" || spec.provider === "azure-foundry") return OPENAI_EFFORTS;
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
  // A family whose contract FORCES an effort (gpt-5-pro / o3-pro are always
  // `high`, even if the user picked something else) overrides the request.
  const forced = contractFor(spec.provider, spec.canonicalId ?? spec.sdkId).reasoning.force;
  const level = forced ?? normalizeEffort(effort, effortLevels(spec));
  if (!level) return {};
  const p = spec.provider;
  if (p === "openai" || p === "azure" || p === "azure-foundry") {
    return { openai: { reasoningEffort: level } };
  }
  if (p === "google" || p === "vertex") {
    return { google: { thinkingConfig: { thinkingLevel: level } } };
  }
  if (p === "anthropic") {
    return { anthropic: { effort: level } };
  }
  // Other providers reason by their own defaults; injecting an unknown param would cause an API error.
  return {};
}
