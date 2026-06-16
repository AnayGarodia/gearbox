// Cross-provider model equivalence. Two model ids share a FAMILY when they are
// the same underlying model offered through different providers (Anthropic API,
// Bedrock, Vertex, a subscription CLI). Failover ranks accounts whose servable
// models share the requested model's family. Keep this DATA-driven and small.
import { MODELS, type ModelSpec } from "../providers.ts";

// Ordered regex to family name. First match wins; strip any "provider/" prefix first.
const FAMILY_RULES: [RegExp, string][] = [
  [/claude.*opus-4/, "claude-opus-4"],
  [/claude.*sonnet-4/, "claude-sonnet-4"],
  [/claude.*haiku-4/, "claude-haiku-4"],
  [/gpt-5\.5-pro/, "gpt-5.5-pro"],
  [/gpt-5\.5-mini/, "gpt-5.5-mini"],
  [/gpt-5\.5/, "gpt-5.5"],
  [/gemini-3\.5-flash/, "gemini-3.5-flash"],
  [/gemini-3\.1-pro/, "gemini-3.1-pro"],
  [/gemini-3\.1-flash-lite/, "gemini-3.1-flash-lite"],
];

/** Normalize a model id (any provider) to a shared family key. */
export function modelFamily(id: string): string {
  const bare = id.replace(/^[a-z0-9-]+\//, "").toLowerCase(); // strip "bedrock/", "vertex/", etc.
  for (const [re, fam] of FAMILY_RULES) if (re.test(bare)) return fam;
  return id;
}

/** Every registered ModelSpec whose family matches the given model. */
export function candidateModelsFor(model: ModelSpec): ModelSpec[] {
  const fam = modelFamily(model.id);
  return MODELS.filter((m) => modelFamily(m.id) === fam);
}

// ── VENDOR lineage (coarser than family) ──────────────────────────────────────
// A cross-family reviewer wants a DIFFERENT VENDOR than the author, not just a
// different version — sonnet reviewing opus is still "claude reasoning about
// claude". This classifies a model to its vendor/lineage from its id (and, for
// hosted ids that hide the vendor, the provider). Each vendor lists the aliases
// an `exclude_family:` entry might use, so "claude" and "anthropic" both match.
const VENDOR_RULES: [RegExp, string[]][] = [
  [/claude|anthropic/, ["claude", "anthropic"]],
  [/gpt|openai|\bo[134]\b|davinci/, ["gpt", "openai", "o1", "o3", "o4"]],
  [/gemini|palm|bison|google/, ["gemini", "google"]],
  [/deepseek/, ["deepseek"]],
  [/grok|x-?ai/, ["grok", "xai"]],
  [/mistral|mixtral|codestral/, ["mistral"]],
  [/llama|meta-/, ["llama", "meta"]],
  [/qwen|qwq/, ["qwen"]],
  [/glm|zhipu|z\.?ai/, ["glm", "zhipu", "zai"]],
  [/moonshot|kimi/, ["kimi", "moonshot"]],
  [/command|cohere/, ["cohere", "command"]],
];

/** Lowercased vendor aliases for a model — used to test family exclusions.
 *  Looks at the model id first (authoritative even for hosted deployments) and
 *  falls back to the provider when the id is opaque. */
export function modelVendorAliases(idOrSpec: string | ModelSpec): string[] {
  const id = (typeof idOrSpec === "string" ? idOrSpec : idOrSpec.id).toLowerCase();
  const provider = typeof idOrSpec === "string" ? "" : (idOrSpec.provider ?? "").toLowerCase();
  const hay = `${id} ${provider}`;
  for (const [re, aliases] of VENDOR_RULES) if (re.test(hay)) return aliases;
  return [];
}

/** True when a model belongs to any of the named families/vendors (an
 *  `exclude_family:` / crossFamily entry). Matching is alias-aware and tolerant
 *  of decoration: "claude" matches a "claude-sonnet-4-6" id and an "anthropic"
 *  provider. An empty/blank family never matches. */
export function modelInFamily(idOrSpec: string | ModelSpec, family: string): boolean {
  const f = family.trim().toLowerCase();
  if (!f) return false;
  const aliases = modelVendorAliases(idOrSpec);
  if (aliases.some((a) => a === f || a.includes(f) || f.includes(a))) return true;
  // Fall back to a raw id/provider substring so an unknown vendor token still
  // works ("foundry", a bespoke deployment name, etc.).
  const id = (typeof idOrSpec === "string" ? idOrSpec : idOrSpec.id).toLowerCase();
  return id.includes(f);
}
