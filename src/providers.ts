// Provider layer: maps a friendly model id to an AI SDK model instance.
// Multi-provider from day one so routing (later) just scores over MODELS.
// This is the ONLY file that touches a concrete provider SDK.
import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { openai, createOpenAI } from "@ai-sdk/openai";
import { google, createGoogleGenerativeAI } from "@ai-sdk/google";
import { deepseek, createDeepSeek } from "@ai-sdk/deepseek";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createVertex } from "@ai-sdk/google-vertex";
import { createAzure } from "@ai-sdk/azure";
import type { LanguageModel } from "ai";
import { accountsForProvider, listAccounts } from "./accounts/store.ts";
import { CATALOG, catalogProvider } from "./accounts/catalog.ts";
import type { Account, ResolvedCreds } from "./accounts/types.ts";

// Provider id is catalog-driven (open string) — the four below are "native"
// (first-party SDK packages); every other provider talks the OpenAI wire.
export type ProviderId = string;
export type NativeProviderId = "anthropic" | "openai" | "google" | "deepseek";
const NATIVE = new Set<string>(["anthropic", "openai", "google", "deepseek"]);

export interface ModelSpec {
  id: string; // friendly id used everywhere, e.g. "claude-sonnet-4-6"
  provider: ProviderId;
  sdkId: string; // the provider's own model string
  label: string; // short display name, e.g. "sonnet-4.6"
  contextWindow: number; // approx tokens; used for the context indicator
  // Routing hints (seeded; the full corpus lives in src/model/profiles.ts).
  // Optional + additive so nothing breaks; the router will read these later.
  cost?: { inUSDPerMtok: number; outUSDPerMtok: number };
  speed?: { ttftMs: number; tps: number };
  quality?: number; // 0–1, e.g. SWE-bench Verified
  reasoning?: boolean; // supports a reasoning/thinking-effort control (see model/reasoning.ts)
  efforts?: string[]; // model/provider-specific reasoning effort values, e.g. low/high/xhigh/max
  capabilities?: {
    tools?: boolean | "unknown";
    images?: boolean | "unknown";
    jsonSchema?: boolean | "unknown";
    systemPrompt?: boolean | "unknown";
    usage?: "exact" | "partial" | "none";
    source?: "official" | "api-discovered" | "user-configured" | "seeded";
  };
}

// The registry. Adding a model is data, not code. Routing will score over this list.
// contextWindow values are approximate (for the UI's context %); refine as needed.
// cost values are approximate public list prices ($/Mtok) — used for the live
// session cost estimate in the status bar (and later by the router).
// Hand-curated, data-rich specs (real cost + context windows; routing scores
// over these via src/model/profiles.ts). Keep these the canonical ids.
const CURATED: ModelSpec[] = [
  // Anthropic (native). Opus 4.8 is the flagship; all support adaptive thinking
  // except Haiku. Sonnet/Opus now carry a 1M context window.
  { id: "claude-opus-4-8", provider: "anthropic", sdkId: "claude-opus-4-8", label: "opus-4.8", contextWindow: 1_000_000, cost: { inUSDPerMtok: 5, outUSDPerMtok: 25 }, reasoning: true, efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-sonnet-4-6", provider: "anthropic", sdkId: "claude-sonnet-4-6", label: "sonnet-4.6", contextWindow: 1_000_000, cost: { inUSDPerMtok: 3, outUSDPerMtok: 15 }, reasoning: true, efforts: ["low", "medium", "high", "max"] },
  { id: "claude-haiku-4-5", provider: "anthropic", sdkId: "claude-haiku-4-5", label: "haiku-4.5", contextWindow: 200_000, cost: { inUSDPerMtok: 1, outUSDPerMtok: 5 } },
  // OpenAI (native). GPT-5.5 reasoning effort: none/minimal/low/medium/high/xhigh.
  { id: "gpt-5.5", provider: "openai", sdkId: "gpt-5.5", label: "gpt-5.5", contextWindow: 400_000, cost: { inUSDPerMtok: 2.5, outUSDPerMtok: 10 }, reasoning: true, efforts: ["none", "minimal", "low", "medium", "high", "xhigh"] },
  { id: "gpt-5.5-pro", provider: "openai", sdkId: "gpt-5.5-pro", label: "gpt-5.5-pro", contextWindow: 400_000, cost: { inUSDPerMtok: 15, outUSDPerMtok: 120 }, reasoning: true, efforts: ["none", "minimal", "low", "medium", "high", "xhigh"] },
  // Google (native). Gemini 3.x with thinking config.
  { id: "gemini-3.1-pro-preview", provider: "google", sdkId: "gemini-3.1-pro-preview", label: "gemini-3.1-pro", contextWindow: 1_000_000, cost: { inUSDPerMtok: 2, outUSDPerMtok: 12 }, reasoning: true, efforts: ["minimal", "low", "medium", "high"] },
  { id: "gemini-3.5-flash", provider: "google", sdkId: "gemini-3.5-flash", label: "gemini-3.5-flash", contextWindow: 1_000_000, cost: { inUSDPerMtok: 0.3, outUSDPerMtok: 2.5 }, reasoning: true, efforts: ["minimal", "low", "medium", "high"] },
  // DeepSeek (native; deepseek-chat/reasoner retire after 2026-07).
  { id: "deepseek-v4-pro", provider: "deepseek", sdkId: "deepseek-v4-pro", label: "deepseek-v4-pro", contextWindow: 128_000, cost: { inUSDPerMtok: 0.4, outUSDPerMtok: 1.75 } },
  { id: "deepseek-v4-flash", provider: "deepseek", sdkId: "deepseek-v4-flash", label: "deepseek-v4-flash", contextWindow: 128_000, cost: { inUSDPerMtok: 0.27, outUSDPerMtok: 1.1 } },
  // Amazon Bedrock — Claude and Amazon Nova models hosted on AWS. Pricing is ~10% above direct.
  // IDs use the provider/sdkId format so they match the generated-model keys and dedup cleanly.
  { id: "bedrock/anthropic.claude-sonnet-4-20250514-v1:0", provider: "bedrock", sdkId: "anthropic.claude-sonnet-4-20250514-v1:0", label: "bedrock/sonnet-4", contextWindow: 200_000, cost: { inUSDPerMtok: 3.3, outUSDPerMtok: 16.5 }, reasoning: true, efforts: ["low", "medium", "high", "max"] },
  { id: "bedrock/anthropic.claude-haiku-4-5-20251001-v1:0", provider: "bedrock", sdkId: "anthropic.claude-haiku-4-5-20251001-v1:0", label: "bedrock/haiku-4.5", contextWindow: 200_000, cost: { inUSDPerMtok: 1.1, outUSDPerMtok: 5.5 }, reasoning: true, efforts: ["low", "medium", "high", "max"] },
  { id: "bedrock/anthropic.claude-opus-4-20250514-v1:0", provider: "bedrock", sdkId: "anthropic.claude-opus-4-20250514-v1:0", label: "bedrock/opus-4", contextWindow: 200_000, cost: { inUSDPerMtok: 5.5, outUSDPerMtok: 27.5 }, reasoning: true, efforts: ["low", "medium", "high", "max"] },
  { id: "bedrock/amazon.nova-pro-v1:0", provider: "bedrock", sdkId: "amazon.nova-pro-v1:0", label: "bedrock/nova-pro", contextWindow: 300_000, cost: { inUSDPerMtok: 0.8, outUSDPerMtok: 3.2 } },
  { id: "bedrock/amazon.nova-lite-v1:0", provider: "bedrock", sdkId: "amazon.nova-lite-v1:0", label: "bedrock/nova-lite", contextWindow: 300_000, cost: { inUSDPerMtok: 0.06, outUSDPerMtok: 0.24 } },
  { id: "bedrock/amazon.nova-micro-v1:0", provider: "bedrock", sdkId: "amazon.nova-micro-v1:0", label: "bedrock/nova-micro", contextWindow: 128_000, cost: { inUSDPerMtok: 0.035, outUSDPerMtok: 0.14 } },
  { id: "bedrock/meta.llama4-maverick-17b-instruct-v1:0", provider: "bedrock", sdkId: "meta.llama4-maverick-17b-instruct-v1:0", label: "bedrock/llama-4-mav", contextWindow: 128_000, cost: { inUSDPerMtok: 0.24, outUSDPerMtok: 0.97 } },
  { id: "bedrock/meta.llama4-scout-17b-instruct-v1:0", provider: "bedrock", sdkId: "meta.llama4-scout-17b-instruct-v1:0", label: "bedrock/llama-4-scout", contextWindow: 128_000, cost: { inUSDPerMtok: 0.17, outUSDPerMtok: 0.66 } },
  // Google Vertex AI — Gemini models via GCP. Same SDK IDs as google native; pricing may differ by project.
  { id: "vertex/gemini-3.1-pro-preview", provider: "vertex", sdkId: "gemini-3.1-pro-preview", label: "vertex/gemini-3.1-pro", contextWindow: 1_000_000, cost: { inUSDPerMtok: 2, outUSDPerMtok: 12 }, reasoning: true, efforts: ["minimal", "low", "medium", "high"] },
  { id: "vertex/gemini-3.5-flash", provider: "vertex", sdkId: "gemini-3.5-flash", label: "vertex/gemini-3.5-flash", contextWindow: 1_000_000, cost: { inUSDPerMtok: 0.3, outUSDPerMtok: 2.5 }, reasoning: true, efforts: ["minimal", "low", "medium", "high"] },
  { id: "vertex/gemini-3.1-flash-lite", provider: "vertex", sdkId: "gemini-3.1-flash-lite", label: "vertex/gemini-3.1-flash-lite", contextWindow: 1_000_000, cost: { inUSDPerMtok: 0.1, outUSDPerMtok: 0.4 } },
];

// Everything else is DATA: derive a spec per catalog `defaultModels` entry so all
// the openai-compat / gateway / cloud providers are selectable, not just stored.
// id is namespaced (`provider/model`) to stay unique; deduped against CURATED by
// provider+sdkId so the canonical natives win. cli providers run via subprocess
// (P3), not resolveModel, so they're excluded here.
function generatedModels(): ModelSpec[] {
  const out: ModelSpec[] = [];
  for (const p of CATALOG) {
    if (p.group === "cli") continue;
    for (const m of p.defaultModels ?? []) {
      if (CURATED.some((c) => c.provider === p.id && c.sdkId === m)) continue;
      out.push({ id: `${p.id}/${m}`, provider: p.id, sdkId: m, label: m.length > 24 ? m.slice(0, 24) : m, contextWindow: 128_000 });
    }
  }
  return out;
}

export const MODELS: ModelSpec[] = [...CURATED, ...generatedModels()];

function accountModelSpecs(): ModelSpec[] {
  const out: ModelSpec[] = [];
  for (const account of listAccounts()) {
    if (!account.enabled || account.exec === "cli") continue;
    for (const sdkId of account.models ?? []) {
      if (!sdkId) continue;
      if (MODELS.some((m) => m.provider === account.provider && m.sdkId === sdkId)) continue;
      const id = `${account.provider}/${sdkId}`;
      out.push({
        id,
        provider: account.provider,
        sdkId,
        label: sdkId.length > 24 ? sdkId.slice(0, 24) : sdkId,
        contextWindow: 128_000,
        capabilities: { source: "user-configured", tools: "unknown", images: "unknown", jsonSchema: "unknown", usage: "partial" },
      });
    }
  }
  return out;
}

export function modelRegistry(): ModelSpec[] {
  const seen = new Set<string>();
  const out: ModelSpec[] = [];
  for (const m of [...MODELS, ...accountModelSpecs()]) {
    const key = `${m.provider}\0${m.sdkId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

// A subscription seat the router can score as a candidate: the canonical model
// (so quality/cost/efforts come from ONE source of truth — the profile/registry)
// surfaced as a `cli:<binary>` candidate that runs through the vendor binary. The
// seat's marginal cost is ≈0 until its rate limit; the scorer's plan bonus, not a
// faked cost, is what makes it preferred — so `canonicalId` keeps the real metered
// price available for the "what it would have cost" comparison. Not added to
// modelRegistry() (which must stay resolvable-only — it feeds resolveModel /
// estimateCost). Empty unless a cli account is configured (default users unaffected).
export interface SubscriptionSeat {
  spec: ModelSpec; // display spec: id `cli:<accountId>:<sdkId>`, provider `cli:<binary>`
  canonicalId?: string; // the registry model id this seat mirrors (profile lookup)
  account: Account;
  binary: string;
  profile?: string; // login profile / config dir for multi-account
}

export function subscriptionSeats(): SubscriptionSeat[] {
  const out: SubscriptionSeat[] = [];
  for (const a of listAccounts()) {
    if (!a.enabled || a.exec !== "cli") continue;
    const binary = (a.auth.kind === "cli" ? a.auth.binary : undefined) ?? catalogProvider(a.provider)?.binary;
    if (!binary) continue;
    const profile = a.auth.kind === "cli" ? a.auth.loginProfile : undefined;
    const sdkIds = a.models ?? catalogProvider(a.provider)?.defaultModels ?? [];
    for (const sdkId of sdkIds) {
      if (!sdkId) continue;
      const canon = CURATED.find((c) => c.sdkId === sdkId && NATIVE.has(c.provider));
      const spec: ModelSpec = {
        ...(canon ?? { contextWindow: 200_000 }),
        id: `cli:${a.id}:${sdkId}`,
        provider: `cli:${binary}`,
        sdkId,
        label: canon?.label ?? sdkId,
      };
      out.push({ spec, canonicalId: canon?.id, account: a, binary, profile });
    }
  }
  return out;
}

const ENV_KEY: Record<NativeProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

// The env var that carries a provider's key (native first, else the catalog's).
function envVarFor(provider: string): string | undefined {
  return ENV_KEY[provider as NativeProviderId] ?? catalogProvider(provider)?.envVars[0];
}

// Cloud creds from the environment (the fallback when there's no account — the
// SDKs also consult their own chains: ~/.aws, ADC, etc.).
function awsFromEnv(): ResolvedCreds["aws"] | undefined {
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  if (!region && !accessKeyId) return undefined;
  return { region: region ?? "us-east-1", accessKeyId: accessKeyId ?? "", secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "", sessionToken: process.env.AWS_SESSION_TOKEN };
}
function azureFromEnv(): ResolvedCreds["azure"] | undefined {
  const resourceName = process.env.AZURE_RESOURCE_NAME;
  const apiKey = process.env.AZURE_API_KEY;
  if (!resourceName && !apiKey) return undefined;
  return { resourceName: resourceName ?? "", apiKey: apiKey ?? "" };
}
function vertexFromEnv(): ResolvedCreds["vertex"] | undefined {
  const project = process.env.GOOGLE_VERTEX_PROJECT;
  if (!project) return undefined;
  return { project, location: process.env.GOOGLE_VERTEX_LOCATION ?? "us-central1" };
}

// Available if a stored account exists for it OR a key is in the env
// (back-compat). Accounts are the durable onboarding path; env is the fallback.
export function providerAvailable(p: ProviderId): boolean {
  if (accountsForProvider(p).length > 0) return true;
  const ev = envVarFor(p);
  return ev ? Boolean(process.env[ev]) : false;
}

export function findModel(idOrLabel: string): ModelSpec | undefined {
  return modelRegistry().find((m) => m.id === idOrLabel || m.label === idOrLabel);
}

/** Approximate USD cost of a set of turns, from each turn's model + token usage. */
export function estimateCost(turns: { model: string; inputTokens: number; outputTokens: number }[]): number {
  let usd = 0;
  for (const t of turns) {
    const c = modelRegistry().find((m) => m.id === t.model)?.cost;
    if (!c) continue;
    usd += (t.inputTokens / 1e6) * c.inUSDPerMtok + (t.outputTokens / 1e6) * c.outUSDPerMtok;
  }
  return usd;
}

// Build the AI SDK model instance. With `creds` (from an account) we configure
// the provider explicitly; without them we use the env-default instances
// (back-compat). Any `creds.baseURL` routes through the OpenAI wire
// protocol — that one path covers every openai-compat provider, gateway, and
// local server, so adding those is data (a catalog row), not code here.
export function resolveModel(spec: ModelSpec, creds?: ResolvedCreds): LanguageModel {
  const apiKey = creds?.apiKey ?? (envVarFor(spec.provider) ? process.env[envVarFor(spec.provider)!] : undefined);

  // Cloud providers (data-driven by catalog authKind): build the cloud client
  // from account creds, else the SDK's own credential chain (AWS profile/role,
  // ADC, etc.). Each carries config beyond a single key.
  const authKind = catalogProvider(spec.provider)?.authKind;
  if (creds?.aws || authKind === "aws") {
    const aws = creds?.aws ?? awsFromEnv();
    const cfg: Record<string, unknown> = {};
    if (aws?.region) cfg.region = aws.region;
    if (aws?.accessKeyId) {
      cfg.accessKeyId = aws.accessKeyId;
      cfg.secretAccessKey = aws.secretAccessKey;
      if (aws.sessionToken) cfg.sessionToken = aws.sessionToken;
    }
    return createAmazonBedrock(cfg)(spec.sdkId);
  }
  if (creds?.azure || authKind === "azure") {
    const az = creds?.azure ?? azureFromEnv();
    return createAzure({ resourceName: az?.resourceName, apiKey: az?.apiKey ?? apiKey, apiVersion: az?.apiVersion })(spec.sdkId);
  }
  if (creds?.vertex || authKind === "vertex") {
    const vx = creds?.vertex ?? vertexFromEnv();
    return createVertex({
      project: vx?.project,
      location: vx?.location,
      ...(vx?.credentials ? { googleAuthOptions: { credentials: vx.credentials } } : {}),
    })(spec.sdkId);
  }

  // OpenAI-wire path: any non-native provider routes through createOpenAI with
  // its catalog baseUrl (account-supplied or default). One path, ~25 providers.
  const baseURL = creds?.baseURL ?? (NATIVE.has(spec.provider) ? undefined : catalogProvider(spec.provider)?.baseUrl);
  if (baseURL) {
    return createOpenAI({ baseURL, apiKey, headers: creds?.headers })(spec.sdkId);
  }
  switch (spec.provider) {
    case "anthropic":
      return apiKey ? createAnthropic({ apiKey })(spec.sdkId) : anthropic(spec.sdkId);
    case "openai":
      return apiKey ? createOpenAI({ apiKey })(spec.sdkId) : openai(spec.sdkId);
    case "google":
      return apiKey ? createGoogleGenerativeAI({ apiKey })(spec.sdkId) : google(spec.sdkId);
    case "deepseek":
      return apiKey ? createDeepSeek({ apiKey })(spec.sdkId) : deepseek(spec.sdkId);
    default:
      // Unknown non-native provider with no baseUrl — fall back to OpenAI wire.
      return createOpenAI({ apiKey, headers: creds?.headers })(spec.sdkId);
  }
}
