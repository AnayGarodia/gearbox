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
