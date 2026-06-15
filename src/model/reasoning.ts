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

// The reasoning shapes reasoningOptions() can translate to a providerOption the
// AI SDK actually sends. Effort is only OFFERED for these — so what the picker
// shows and the flywheel records equals what the wire receives. (#11)
const EMITTABLE_SHAPES = new Set(["openai-effort", "anthropic-thinking", "google-thinking"]);

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
  const contract = contractFor(spec.provider, spec.canonicalId ?? spec.sdkId);
  // A family whose contract FORCES one effort (gpt-5-pro/o3-pro are always high)
  // exposes only that level — so the picker, the clamp notice, the cost/latency
  // estimate, and reasoningOptions() all agree on what actually gets sent. This
  // must run BEFORE spec.efforts, or a curated `efforts` list (gpt-5.5-pro ships
  // one) would display levels the wire silently rewrites to `high`. (S1)
  if (contract.reasoning.force) return [contract.reasoning.force];
  const vocab = contract.reasoning.vocab;
  if (spec.efforts) {
    // The contract vocab is AUTHORITATIVE: a curated `efforts` list can be stale
    // or over-broad (gpt-5.5 ships minimal/xhigh, but the docs only accept
    // none/low/medium/high), and an unsupported effort is a hard 400 on the
    // wire. Intersect so the picker/router never offer a level the wire rejects.
    // (#9/#10) Empty vocab = no contract opinion → trust the curated list.
    return vocab.length ? spec.efforts.filter((e) => vocab.includes(e)) : spec.efforts;
  }
  // Reasoning-capable? Honor an EXPLICIT spec.reasoning (true/false); when it is
  // unset — every discovered/generated/models.dev spec — fall to the contract's
  // shape, so an Azure/Foundry reasoning deployment still clamps to its vocab
  // instead of getting no effort knob at all. (N10)
  const reasons = spec.reasoning ?? contract.reasoning.shape !== "none";
  if (!reasons) return [];
  // Only offer effort for shapes reasoningOptions() can actually EMIT
  // (openai-effort / anthropic-thinking / google-thinking). For provider-native
  // shapes (thinking-toggle, variant-id, think-tag, always-on) the AI SDK carries
  // no param yet, so reasoningOptions returns {} — offering a level here would let
  // the picker/router/flywheel record an effort the wire never sends (the #11
  // divergence). Honest: no knob until the native param is wired. (#11)
  if (!EMITTABLE_SHAPES.has(contract.reasoning.shape)) return [];
  // The per-model contract carries the DOCUMENTED effort vocabulary per family
  // (o3 = low/med/high only, base gpt-5 adds minimal) — prefer it over the coarse
  // provider-wide default below.
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
  // Dispatch on the contract's reasoning SHAPE, not spec.provider — the two
  // disagreed before (a provider allowlist meant Bedrock Claude emitted nothing
  // and Vertex Claude would get the Gemini param), so the router/flywheel
  // believed an effort ran that the wire never sent. The shape is the single
  // source of truth for HOW reasoning is enabled. (Root A: #1/#2/#3)
  const r = contractFor(spec.provider, spec.canonicalId ?? spec.sdkId).reasoning;
  // FORCED families (gpt-5-pro/o3-pro = always high) override the request; else
  // normalize to a vocab-valid level (effortLevels already intersected to vocab).
  const level = r.force ?? normalizeEffort(effort, effortLevels(spec));
  if (!level) return {};
  switch (r.shape) {
    case "openai-effort":
      // reasoning_effort — native OpenAI/Azure, and the openai-effort carriers
      // (xai grok-4.3/3-mini, groq gpt-oss/qwen3).
      return { openai: { reasoningEffort: level } };
    case "anthropic-thinking":
      return { anthropic: { effort: level } };
    case "google-thinking":
      return { google: { thinkingConfig: { thinkingLevel: level } } };
    default:
      // thinking-toggle / think-tag / variant-id / always-on / none: reasoning is
      // provider-native (a non-standard body field) or has no param — injecting
      // one would 400. The AI SDK doesn't carry these yet, so emit nothing.
      return {};
  }
}
