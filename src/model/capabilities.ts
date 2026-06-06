import { modelRegistry, type ModelSpec } from "../providers.ts";
import { catalogProvider } from "../accounts/catalog.ts";
import { profileFor } from "./profiles.ts";
import { effortLevels } from "./reasoning.ts";

export type CapabilityValue = boolean | "unknown";
export type UsageSupport = "exact" | "partial" | "none";
export type CapabilitySource = "official" | "api-discovered" | "user-configured" | "seeded";
export type ModelRequirement = "tools" | "images" | "jsonSchema" | "reasoningEffort";

export interface ModelCapabilities {
  text: boolean;
  streaming: boolean;
  tools: CapabilityValue;
  images: CapabilityValue;
  jsonSchema: CapabilityValue;
  reasoningEffort: false | string[];
  systemPrompt: CapabilityValue;
  usage: UsageSupport;
  contextWindow?: number;
  maxOutputTokens?: number;
  pricing?: { input: number; output: number; source: CapabilitySource };
  source: CapabilitySource;
}

function providerSource(spec: ModelSpec): CapabilitySource {
  if (spec.capabilities?.source) return spec.capabilities.source;
  const group = catalogProvider(spec.provider)?.group;
  if (group === "gateway" || group === "openai-compat" || group === "local") return "seeded";
  return "seeded";
}

function exactUsage(spec: ModelSpec): UsageSupport {
  if (spec.capabilities?.usage) return spec.capabilities.usage;
  if (spec.provider === "anthropic" || spec.provider === "openai" || spec.provider === "google" || spec.provider === "deepseek") return "exact";
  const group = catalogProvider(spec.provider)?.group;
  if (group === "cloud" || group === "gateway" || group === "openai-compat") return "partial";
  return "none";
}

function toolSupport(spec: ModelSpec): CapabilityValue {
  if (spec.capabilities?.tools != null) return spec.capabilities.tools;
  const group = catalogProvider(spec.provider)?.group;
  if (spec.provider === "anthropic" || spec.provider === "openai" || spec.provider === "google" || spec.provider === "deepseek") return true;
  if (spec.provider === "bedrock") return !spec.sdkId.includes("nova-micro");
  if (spec.provider === "vertex" || spec.provider === "azure" || spec.provider === "azure-foundry") return true;
  if (group === "gateway" || group === "openai-compat" || group === "local") return "unknown";
  return "unknown";
}

function imageSupport(spec: ModelSpec): CapabilityValue {
  if (spec.capabilities?.images != null) return spec.capabilities.images;
  if (spec.provider === "anthropic" || spec.provider === "openai" || spec.provider === "google" || spec.provider === "vertex") return true;
  if (spec.provider === "deepseek") return false;
  if (spec.provider === "bedrock") return !spec.sdkId.includes("nova-micro");
  if (spec.provider === "azure" || spec.provider === "azure-foundry") return true;
  return "unknown";
}

function schemaSupport(spec: ModelSpec): CapabilityValue {
  if (spec.capabilities?.jsonSchema != null) return spec.capabilities.jsonSchema;
  if (spec.provider === "openai" || spec.provider === "google" || spec.provider === "anthropic") return true;
  if (spec.provider === "bedrock") return spec.sdkId.startsWith("anthropic.") ? true : "unknown";
  if (spec.provider === "vertex" || spec.provider === "azure" || spec.provider === "azure-foundry") return true;
  if (spec.provider === "deepseek") return "unknown";
  return "unknown";
}

export function capabilitiesFor(spec: ModelSpec): ModelCapabilities {
  const profile = profileFor(spec.id);
  const source = providerSource(spec);
  const efforts = effortLevels(spec);
  const rawCost = profile?.cost ?? spec.cost;
  const cost = rawCost
    ? {
        input: rawCost.inUSDPerMtok,
        output: rawCost.outUSDPerMtok,
        source: (profile?.cost.src === "researched" ? "official" : "seeded") as CapabilitySource,
      }
    : undefined;

  return {
    text: true,
    streaming: true,
    tools: toolSupport(spec),
    images: imageSupport(spec),
    jsonSchema: schemaSupport(spec),
    reasoningEffort: efforts.length ? efforts : false,
    systemPrompt: spec.capabilities?.systemPrompt ?? true,
    usage: exactUsage(spec),
    contextWindow: profile?.contextWindow ?? spec.contextWindow,
    maxOutputTokens: profile?.maxOutput,
    pricing: cost,
    source,
  };
}

export function missingRequirements(spec: ModelSpec, required: ModelRequirement[] = []): ModelRequirement[] {
  if (!required.length) return [];
  const caps = capabilitiesFor(spec);
  return required.filter((r) => {
    if (r === "reasoningEffort") return caps.reasoningEffort === false;
    return caps[r] !== true;
  });
}

export function supportsRequirements(spec: ModelSpec, required: ModelRequirement[] = []): boolean {
  return missingRequirements(spec, required).length === 0;
}

function cell(v: CapabilityValue | boolean | string[] | false | UsageSupport | undefined): string {
  if (Array.isArray(v)) return v.join("/");
  if (v === true) return "yes";
  if (v === false) return "no";
  if (v === "unknown") return "?";
  return String(v ?? "");
}

export function formatCapabilityMatrix(models: ModelSpec[] = modelRegistry()): string {
  const rows = models.map((m) => {
    const c = capabilitiesFor(m);
    return {
      provider: m.provider,
      model: m.label,
      tools: cell(c.tools),
      images: cell(c.images),
      schema: cell(c.jsonSchema),
      effort: cell(c.reasoningEffort),
      usage: c.usage,
      source: c.source,
    };
  });
  const widths = {
    provider: Math.max("provider".length, ...rows.map((r) => r.provider.length)),
    model: Math.max("model".length, ...rows.map((r) => r.model.length)),
    tools: "tools".length,
    images: "image".length,
    schema: "schema".length,
    effort: Math.max("effort".length, ...rows.map((r) => r.effort.length)),
    usage: "usage".length,
  };
  const pad = (s: string, n: number) => s.padEnd(n);
  const header = [
    pad("provider", widths.provider),
    pad("model", widths.model),
    pad("tools", widths.tools),
    pad("image", widths.images),
    pad("schema", widths.schema),
    pad("effort", widths.effort),
    pad("usage", widths.usage),
    "source",
  ].join("  ");
  const body = rows.map((r) => [
    pad(r.provider, widths.provider),
    pad(r.model, widths.model),
    pad(r.tools, widths.tools),
    pad(r.images, widths.images),
    pad(r.schema, widths.schema),
    pad(r.effort, widths.effort),
    pad(r.usage, widths.usage),
    r.source,
  ].join("  "));
  return [header, ...body].join("\n");
}
