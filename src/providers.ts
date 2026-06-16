/**
 * Provider layer: the only file in Gearbox that imports concrete provider SDKs.
 *
 * Responsibility: map a friendly ModelSpec to an AI SDK LanguageModel instance
 * that the rest of the app can pass to `streamText` / `generateText`. No other
 * file should import from "@ai-sdk/anthropic", "@ai-sdk/openai", etc. Keeping
 * all SDK imports here makes it straightforward to swap or add a provider SDK
 * without touching the rest of the codebase.
 *
 * Architecture overview:
 *
 *   MODELS (exported const)
 *     A static array seeded at module load time: CURATED specs (hand-authored,
 *     data-rich) merged with generatedModels() (one spec per catalog entry that
 *     is not already in CURATED). MODELS never changes at runtime.
 *
 *   modelRegistry() (exported function)
 *     The live, call-time view of what is selectable. Merges MODELS with
 *     accountModelSpecs() (models discovered from real accounts), suppresses
 *     seed entries for any provider that now has a real discovered list, and
 *     deduplicates by provider+sdkId. The selector, cost estimator, and
 *     resolveModel all read from here, not from MODELS directly.
 *
 *   resolveModel(spec, creds?) (exported function)
 *     Builds the LanguageModel for a given spec. With explicit creds (from an
 *     account record) it configures the client directly. Without them it falls
 *     back to env-var defaults for backward compatibility. The cloud paths
 *     (Bedrock, Azure, Vertex) are data-driven by catalogProvider().authKind,
 *     so adding a new cloud provider is a catalog row, not new code here.
 *
 * Credential resolution order (per provider):
 *   1. Explicit ResolvedCreds from a saved account (passed by the caller).
 *   2. The named environment variable in ENV_KEY / catalogProvider().envVars[0].
 *   3. The SDK's own ambient credential chain (AWS profile/role, Google ADC, etc.).
 *
 * The "only provider SDK touch" constraint means routing, cost estimation, and
 * the model selector are all free of SDK imports and can be tested without
 * setting up real credentials.
 */
import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { openai, createOpenAI } from "@ai-sdk/openai";
import { google, createGoogleGenerativeAI } from "@ai-sdk/google";
import { deepseek, createDeepSeek } from "@ai-sdk/deepseek";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createVertex } from "@ai-sdk/google-vertex";
import { createAzure } from "@ai-sdk/azure";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { EmbeddingModel, LanguageModel } from "ai";
import { accountsForProvider, listAccounts } from "./accounts/store.ts";
import { profileFor } from "./model/profiles.ts";
import { contractFor } from "./model/contract.ts";
import { listPriceFor, priceFor, type Price } from "./model/pricing.ts";
import { CATALOG, catalogProvider } from "./accounts/catalog.ts";
import type { Account, ResolvedCreds } from "./accounts/types.ts";
import { loadCachedCatalog } from "./model/modelsdev.ts";

// Provider id is catalog-driven (open string). The four below are "native"
// (first-party SDK packages); every other provider talks the OpenAI wire.
export type ProviderId = string;
export type NativeProviderId = "anthropic" | "openai" | "google" | "deepseek";

/**
 * The set of providers that have a first-party SDK package installed.
 * Non-native providers (openai-compat, gateways, local servers) all route
 * through createOpenAI({ baseURL }) so they require no additional SDK.
 */
const NATIVE = new Set<string>(["anthropic", "openai", "google", "deepseek"]);

/**
 * Static description of a model that Gearbox can run.
 *
 * Used by the selector (display + filtering), the cost estimator (cost field),
 * the context indicator (contextWindow), and resolveModel (provider + sdkId).
 * All fields except id, provider, sdkId, label, and contextWindow are optional
 * and additive: omitting them never breaks anything, the router just has less
 * signal to work with.
 */
export interface ModelSpec {
  /** Friendly id used throughout the app, e.g. "claude-sonnet-4-6". */
  id: string;
  provider: ProviderId;
  /** The model string the provider's own API expects, e.g. "claude-sonnet-4-6". */
  sdkId: string;
  /** Short display name shown in the status bar and selector, e.g. "sonnet-4.6". */
  label: string;
  /** Approximate context-window size in tokens; used for the context-% indicator. */
  contextWindow: number;
  // Routing hints. Seeded values are best-effort; the full measured corpus
  // lives in src/model/profiles.ts. The router reads from both sources.
  /** Public list price in USD per million tokens. Used for the live cost estimate. */
  cost?: { inUSDPerMtok: number; outUSDPerMtok: number };
  /** Latency hints (TTFT in ms, throughput in tokens/s) for the router scorer. */
  speed?: { ttftMs: number; tps: number };
  /** Quality score on a 0-1 scale, e.g. SWE-bench Verified pass rate. */
  quality?: number;
  /** True when this model supports a reasoning/thinking-effort control. */
  reasoning?: boolean;
  /** Model-specific effort level strings, e.g. ["low","medium","high","max"]. */
  efforts?: string[];
  /** false = selectable via /model but EXCLUDED from auto-routing (models.dev
   *  catalog entries: callable, but unvetted for quality — routing to them
   *  silently would trade reliability for novelty). */
  routable?: boolean;
  capabilities?: {
    tools?: boolean | "unknown";
    images?: boolean | "unknown";
    jsonSchema?: boolean | "unknown";
    systemPrompt?: boolean | "unknown";
    usage?: "exact" | "partial" | "none";
    /** How this spec was sourced: official docs, live API, user config, or seeded guess. */
    source?: "official" | "api-discovered" | "user-configured" | "seeded";
  };
  /** For a discovered deployment whose name maps to a known model family
   *  (e.g. an Azure deployment "my-gpt-5.5" → "gpt-5.5"): the canonical curated
   *  id, so cost/quality/benchmark resolve against it. Lets discovered Azure /
   *  Foundry / gateway models be ROUTED (otherwise they have no benchmark
   *  quality and are floored out of code/plan tasks). */
  canonicalId?: string;
}

/**
 * MODELS: the static base registry, built once at module load.
 *
 * It is the union of CURATED (hand-authored specs with real cost, context
 * window, and routing data) and generatedModels() (one lightweight spec per
 * catalog defaultModels entry that is not already in CURATED). Adding a model
 * is data, not code: drop a row in CURATED or add an entry to the catalog.
 *
 * Do NOT iterate this array directly at call time. Use modelRegistry(), which
 * overlays account-discovered models, suppresses stale seeds, and deduplicates.
 */

// contextWindow values are approximate (for the UI context-% indicator); refine as needed.
// cost values are approximate public list prices ($/Mtok) used for the live cost estimate.
// Hand-curated, data-rich specs: keep these the canonical ids.
const CURATED: ModelSpec[] = [
  // Anthropic (native). Sonnet and Opus carry a 1M context window.
  // All three support adaptive thinking (extended thinking) except Haiku.
  { id: "claude-opus-4-8", provider: "anthropic", sdkId: "claude-opus-4-8", label: "opus-4.8", contextWindow: 1_000_000, cost: { inUSDPerMtok: 5, outUSDPerMtok: 25 }, reasoning: true, efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-sonnet-4-6", provider: "anthropic", sdkId: "claude-sonnet-4-6", label: "sonnet-4.6", contextWindow: 1_000_000, cost: { inUSDPerMtok: 3, outUSDPerMtok: 15 }, reasoning: true, efforts: ["low", "medium", "high", "max"] },
  { id: "claude-haiku-4-5", provider: "anthropic", sdkId: "claude-haiku-4-5", label: "haiku-4.5", contextWindow: 200_000, cost: { inUSDPerMtok: 1, outUSDPerMtok: 5 } },
  // OpenAI (native). Reasoning effort levels: none/minimal/low/medium/high/xhigh.
  { id: "gpt-5.5", provider: "openai", sdkId: "gpt-5.5", label: "gpt-5.5", contextWindow: 400_000, cost: { inUSDPerMtok: 2.5, outUSDPerMtok: 10 }, reasoning: true, efforts: ["none", "minimal", "low", "medium", "high", "xhigh"] },
  { id: "gpt-5.5-pro", provider: "openai", sdkId: "gpt-5.5-pro", label: "gpt-5.5-pro", contextWindow: 400_000, cost: { inUSDPerMtok: 15, outUSDPerMtok: 120 }, reasoning: true, efforts: ["none", "minimal", "low", "medium", "high", "xhigh"] },
  // Google (native). Gemini 3.x models with thinking config support.
  { id: "gemini-3.1-pro-preview", provider: "google", sdkId: "gemini-3.1-pro-preview", label: "gemini-3.1-pro", contextWindow: 1_000_000, cost: { inUSDPerMtok: 2, outUSDPerMtok: 12 }, reasoning: true, efforts: ["minimal", "low", "medium", "high"] },
  { id: "gemini-3.5-flash", provider: "google", sdkId: "gemini-3.5-flash", label: "gemini-3.5-flash", contextWindow: 1_000_000, cost: { inUSDPerMtok: 0.3, outUSDPerMtok: 2.5 }, reasoning: true, efforts: ["minimal", "low", "medium", "high"] },
  // DeepSeek (native; deepseek-chat/reasoner retire after 2026-07).
  { id: "deepseek-v4-pro", provider: "deepseek", sdkId: "deepseek-v4-pro", label: "deepseek-v4-pro", contextWindow: 128_000, cost: { inUSDPerMtok: 0.4, outUSDPerMtok: 1.75 } },
  { id: "deepseek-v4-flash", provider: "deepseek", sdkId: "deepseek-v4-flash", label: "deepseek-v4-flash", contextWindow: 128_000, cost: { inUSDPerMtok: 0.27, outUSDPerMtok: 1.1 } },
  // Amazon Bedrock: Claude and Nova models hosted on AWS. Pricing is ~10% above direct.
  // IDs use "provider/sdkId" format to stay unique and match generated-model keys.
  { id: "bedrock/anthropic.claude-sonnet-4-20250514-v1:0", provider: "bedrock", sdkId: "anthropic.claude-sonnet-4-20250514-v1:0", label: "bedrock/sonnet-4", contextWindow: 200_000, cost: { inUSDPerMtok: 3.3, outUSDPerMtok: 16.5 }, reasoning: true, efforts: ["low", "medium", "high", "max"] },
  { id: "bedrock/anthropic.claude-haiku-4-5-20251001-v1:0", provider: "bedrock", sdkId: "anthropic.claude-haiku-4-5-20251001-v1:0", label: "bedrock/haiku-4.5", contextWindow: 200_000, cost: { inUSDPerMtok: 1.1, outUSDPerMtok: 5.5 } },
  { id: "bedrock/anthropic.claude-opus-4-20250514-v1:0", provider: "bedrock", sdkId: "anthropic.claude-opus-4-20250514-v1:0", label: "bedrock/opus-4", contextWindow: 200_000, cost: { inUSDPerMtok: 5.5, outUSDPerMtok: 27.5 }, reasoning: true, efforts: ["low", "medium", "high", "max"] },
  { id: "bedrock/amazon.nova-pro-v1:0", provider: "bedrock", sdkId: "amazon.nova-pro-v1:0", label: "bedrock/nova-pro", contextWindow: 300_000, cost: { inUSDPerMtok: 0.8, outUSDPerMtok: 3.2 } },
  { id: "bedrock/amazon.nova-lite-v1:0", provider: "bedrock", sdkId: "amazon.nova-lite-v1:0", label: "bedrock/nova-lite", contextWindow: 300_000, cost: { inUSDPerMtok: 0.06, outUSDPerMtok: 0.24 } },
  { id: "bedrock/amazon.nova-micro-v1:0", provider: "bedrock", sdkId: "amazon.nova-micro-v1:0", label: "bedrock/nova-micro", contextWindow: 128_000, cost: { inUSDPerMtok: 0.035, outUSDPerMtok: 0.14 } },
  { id: "bedrock/meta.llama4-maverick-17b-instruct-v1:0", provider: "bedrock", sdkId: "meta.llama4-maverick-17b-instruct-v1:0", label: "bedrock/llama-4-mav", contextWindow: 128_000, cost: { inUSDPerMtok: 0.24, outUSDPerMtok: 0.97 } },
  { id: "bedrock/meta.llama4-scout-17b-instruct-v1:0", provider: "bedrock", sdkId: "meta.llama4-scout-17b-instruct-v1:0", label: "bedrock/llama-4-scout", contextWindow: 128_000, cost: { inUSDPerMtok: 0.17, outUSDPerMtok: 0.66 } },
  // Google Vertex AI: Gemini models via GCP. Same SDK IDs as the google-native provider;
  // pricing may differ by project. Credentials come from the Vertex auth chain (ADC/SA).
  { id: "vertex/gemini-3.1-pro-preview", provider: "vertex", sdkId: "gemini-3.1-pro-preview", label: "vertex/gemini-3.1-pro", contextWindow: 1_000_000, cost: { inUSDPerMtok: 2, outUSDPerMtok: 12 }, reasoning: true, efforts: ["minimal", "low", "medium", "high"] },
  { id: "vertex/gemini-3.5-flash", provider: "vertex", sdkId: "gemini-3.5-flash", label: "vertex/gemini-3.5-flash", contextWindow: 1_000_000, cost: { inUSDPerMtok: 0.3, outUSDPerMtok: 2.5 }, reasoning: true, efforts: ["minimal", "low", "medium", "high"] },
  { id: "vertex/gemini-3.1-flash-lite", provider: "vertex", sdkId: "gemini-3.1-flash-lite", label: "vertex/gemini-3.1-flash-lite", contextWindow: 1_000_000, cost: { inUSDPerMtok: 0.1, outUSDPerMtok: 0.4 } },
];

/**
 * Builds lightweight ModelSpec entries from catalog defaultModels for every
 * non-CLI, non-discoverOnly provider that is not already covered by CURATED.
 *
 * Resulting specs are tagged source:"seeded" to mark them as catalog examples,
 * not confirmed callable ids. modelRegistry() drops them for any provider that
 * has a real account-discovered model list, preventing the "listed model 404s"
 * bug on any provider, not just Azure.
 *
 * CLI providers are excluded here because they run via subprocess (not
 * resolveModel) and are handled separately by subscriptionSeats().
 *
 * discoverOnly providers (e.g. Azure, Foundry) are also excluded: their
 * catalog defaultModels are deployment-name examples, and advertising them
 * as callable before discovery is the root cause of deployment-404 errors.
 */
function generatedModels(): ModelSpec[] {
  const out: ModelSpec[] = [];
  for (const p of CATALOG) {
    if (p.group === "cli") continue;
    // discoverOnly providers (Azure, Foundry): the catalog `defaultModels` are
    // examples, not callable ids — advertising them as "ready to use" is exactly
    // the deployment-404 bug. Their real set comes from discovery -> account.models.
    if (p.discoverOnly) continue;
    for (const m of p.defaultModels ?? []) {
      if (CURATED.some((c) => c.provider === p.id && c.sdkId === m)) continue;
      // `seeded`: a catalog EXAMPLE, not confirmed against any account. Once an
      // account for this provider has a discovered model set, these are dropped
      // in favour of the real list (see modelRegistry) — that's what keeps the
      // "listed model 404s" bug from recurring on ANY provider, not just Azure.
      out.push({ id: `${p.id}/${m}`, provider: p.id, sdkId: m, label: m.length > 24 ? m.slice(0, 24) : m, contextWindow: 128_000, capabilities: { source: "seeded" } });
    }
  }
  return out;
}

export const MODELS: ModelSpec[] = [...CURATED, ...generatedModels()];

/**
 * Builds ModelSpec entries for every model that has been discovered from a
 * real account (via src/accounts/discover.ts) and stored in account.models.
 *
 * Specs are tagged source:"api-discovered" and capabilities are marked
 * "unknown" because the discovery endpoint does not expose them. CURATED
 * models are excluded: their canonical spec always takes precedence, and
 * the dedup in modelRegistry() enforces that order.
 */
function accountModelSpecs(): ModelSpec[] {
  const out: ModelSpec[] = [];
  for (const account of listAccounts()) {
    if (!account.enabled || account.exec === "cli") continue;
    for (const sdkId of account.models ?? []) {
      if (!sdkId) continue;
      // Don't pre-filter against MODELS here — modelRegistry dedups, and a
      // discovered model that shares an id with a seed must still win once its
      // provider's seeds are dropped.
      if (CURATED.some((m) => m.provider === account.provider && m.sdkId === sdkId)) continue;
      const id = `${account.provider}/${sdkId}`;
      // Discovery exposes no pricing — fall back to the canonical family's list
      // rate when the deployment name unambiguously matches one (DeepSeek-V4-Pro,
      // my-gpt-5.5, …) so cost estimates and routing aren't blind. No match →
      // cost stays undefined and the UI keeps the honest "$ unknown".
      // PROVIDER-SCOPED first: the same model bills differently per host (a
      // Foundry-hosted DeepSeek is ~4x its native rate), and this baked spec.cost
      // is read before the listPriceFor fallback in costFor — so the host rate has
      // to land HERE or it's shadowed by the native canonical rate.
      const canonical = canonicalIdFor(sdkId);
      const cost = listPriceFor(account.provider, sdkId) ?? canonicalPricingFor(sdkId);
      out.push({
        id,
        provider: account.provider,
        sdkId,
        label: sdkId,
        contextWindow: 128_000,
        ...(cost ? { cost } : {}),
        // When the deployment name resolves to a known family, carry the
        // canonical id so the router resolves its quality/benchmark — without
        // this an Azure/Foundry/gateway deployment is floored out of code tasks.
        ...(canonical ? { canonicalId: canonical } : {}),
        capabilities: { source: "api-discovered", tools: "unknown", images: "unknown", jsonSchema: "unknown", usage: "partial" },
      });
    }
  }
  return out;
}

/**
 * Returns the set of provider ids whose seeded (catalog example) entries
 * should be hidden from the registry.
 *
 * A provider is suppressed when:
 *   - It is flagged discoverOnly in the catalog (deployment-named providers
 *     like Azure where the defaultModels are never callable as-is), OR
 *   - It has an enabled account with at least one discovered model (the
 *     real list is available so the seeded guesses are stale and misleading).
 */
function seedSuppressedProviders(): Set<string> {
  const s = new Set<string>();
  for (const p of CATALOG) if (p.discoverOnly) s.add(p.id);
  for (const a of listAccounts()) {
    if (a.enabled && a.exec !== "cli" && (a.models?.length ?? 0) > 0) s.add(a.provider);
  }
  return s;
}

/**
 * Returns the live, call-time model registry.
 *
 * This is the authoritative list of models that can be selected, resolved,
 * and costed. It is computed fresh on every call (no module-level cache) so
 * changes to the account store are reflected immediately.
 *
 * Algorithm:
 *   1. Start from MODELS (static base).
 *   2. Drop seeded entries for any provider in seedSuppressedProviders().
 *   3. Append accountModelSpecs() (discovered models from saved accounts).
 *   4. Deduplicate by provider+sdkId, with the static base winning over
 *      discovered duplicates (earlier entries are kept).
 *
 * Only models returned here are valid inputs to resolveModel().
 */
export function modelRegistry(): ModelSpec[] {
  const suppressed = seedSuppressedProviders();
  // Drop seed examples for any provider that now has a real (discovered) list.
  const base = MODELS.filter((m) => !(m.capabilities?.source === "seeded" && suppressed.has(m.provider)));
  const seen = new Set<string>();
  const out: ModelSpec[] = [];
  for (const m of [...base, ...accountModelSpecs(), ...modelsDevSpecs()]) {
    const key = `${m.provider}\0${m.sdkId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

// ── models.dev catalog overlay ───────────────────────────────────────────────
// The synced catalog (src/model/modelsdev.ts, refreshed in the background and
// by /model refresh) makes new models PIN-ABLE the day they ship, without a
// gearbox release. They merge lowest-priority (curated + discovered always
// win), only for providers you can actually call, and with routable:false —
// /model can pin them, auto-routing never gambles on them.
let _modelsDevSpecs: ModelSpec[] | null = null;

function modelsDevSpecs(): ModelSpec[] {
  if (_modelsDevSpecs) return _modelsDevSpecs;
  try {
    const cached = loadCachedCatalog();
    const entries = cached?.entries ?? [];
    _modelsDevSpecs = entries
      .filter((e) => providerAvailable(e.provider))
      .map((e) => ({
        id: `${e.provider}/${e.id}`,
        provider: e.provider,
        sdkId: e.id,
        label: e.label || e.id,
        contextWindow: e.contextWindow ?? 128_000,
        cost: e.cost ? { inUSDPerMtok: e.cost.inUSDPerMtok, outUSDPerMtok: e.cost.outUSDPerMtok } : undefined,
        routable: false,
        capabilities: { tools: e.tools ?? "unknown", images: e.images ?? "unknown", source: "api-discovered" as const },
      }));
  } catch {
    _modelsDevSpecs = [];
  }
  return _modelsDevSpecs;
}

/** Drop the in-memory overlay so the next modelRegistry() re-reads the synced
 *  cache (called after /model refresh). */
export function refreshModelsDevOverlay(): void {
  _modelsDevSpecs = null;
}

/**
 * A CLI subscription seat that the router can score as a candidate.
 *
 * Subscription accounts (claude, codex, etc.) run through a vendor binary
 * rather than an API key, so they never appear in modelRegistry(). They are
 * surfaced here instead, as SubscriptionSeat records, so the router can
 * compare them against metered API candidates.
 *
 * The `spec` id uses the format "cli:<accountId>:<sdkId>" and its provider is
 * "cli:<binary>", which resolveModel never sees (the caller routes these to
 * the subprocess path). `canonicalId` points to the matching CURATED entry so
 * quality, cost, and effort data come from one source of truth. The marginal
 * cost of a subscription seat is ~0 until its rate limit; the scorer uses a
 * plan bonus rather than faking a price, and `canonicalId` keeps the real
 * metered price available for "what it would have cost" comparisons.
 *
 * Empty unless a CLI account is configured; default (API-key) users are
 * unaffected.
 */
export interface SubscriptionSeat {
  /** Display spec with id "cli:<accountId>:<sdkId>", provider "cli:<binary>". */
  spec: ModelSpec;
  /** Registry model id this seat mirrors, for profile/cost lookups. */
  canonicalId?: string;
  account: Account;
  binary: string;
  /** Login profile / config dir, for multi-account CLI setups. */
  profile?: string;
}

/** True when a vendor CLI binary can actually serve a model id. A seat must
 *  NEVER be minted for a model its binary can't run: `claude --model gpt-5.5`
 *  (or codex handed a claude id) fails at turn time, after routing already
 *  committed to the seat. The namespaces are vendor-stable: claude serves only
 *  claude-* ids; codex serves OpenAI ids (gpt-*, o-series, codex-*). Unknown
 *  binaries pass (no namespace knowledge — don't block a future vendor). Pure. */
export function binaryServesModel(binary: string, sdkId: string): boolean {
  const id = sdkId.toLowerCase();
  if (binary.includes("claude")) return id.startsWith("claude");
  if (binary.includes("codex")) return /^(gpt-|o\d|codex)/.test(id);
  return true;
}

export function subscriptionSeats(): SubscriptionSeat[] {
  const out: SubscriptionSeat[] = [];
  for (const a of listAccounts()) {
    if (!a.enabled || a.exec !== "cli") continue;
    const binary = (a.auth.kind === "cli" ? a.auth.binary : undefined) ?? catalogProvider(a.provider)?.binary;
    if (!binary) continue;
    const profile = a.auth.kind === "cli" ? a.auth.loginProfile : undefined;
    // CLI subscriptions have no per-account model discovery, so the catalog is the
    // source of truth for what the plan can run. UNION the account's stored list (a
    // snapshot frozen at add-time) with the live catalog defaults, so a model added
    // to the catalog later (e.g. haiku) reaches already-configured subscriptions
    // without the user re-adding them.
    const catalogModels = catalogProvider(a.provider)?.defaultModels ?? [];
    const sdkIds = [...new Set([...(a.models ?? []), ...catalogModels])];
    for (const sdkId of sdkIds) {
      if (!sdkId) continue;
      // Guard: a polluted snapshot (account.models carrying a foreign id) must
      // not become a seat the binary can't serve.
      if (!binaryServesModel(binary, sdkId)) continue;
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

/**
 * Maps each native provider id to the environment variable that carries its
 * API key. These are the canonical env var names documented by each provider.
 *
 * Credential resolution order for native providers:
 *   1. ResolvedCreds.apiKey (from a saved account record).
 *   2. The env var listed here (backward-compatible path for users who set
 *      keys directly in their shell environment).
 *   3. The provider SDK's own ambient lookup (varies by SDK).
 *
 * Non-native providers fall back to catalogProvider(id).envVars[0].
 */
const ENV_KEY: Record<NativeProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

/** Returns the env var name carrying a provider's API key — the first one of
 *  the provider's documented names that is actually SET wins (Google's own
 *  quickstarts export GEMINI_API_KEY, not GOOGLE_GENERATIVE_AI_API_KEY; zai
 *  documents both ZAI_API_KEY and ZHIPU_API_KEY). Falls back to the primary
 *  name so "which var should I set" messages stay deterministic. */
function envVarFor(provider: string): string | undefined {
  const names = [ENV_KEY[provider as NativeProviderId], ...(catalogProvider(provider)?.envVars ?? [])].filter(Boolean) as string[];
  return names.find((v) => process.env[v]) ?? names[0];
}

/**
 * Reads AWS credentials from environment variables.
 * Returns undefined when neither AWS_REGION nor AWS_ACCESS_KEY_ID is set,
 * allowing the SDK's own credential chain (instance role, ~/.aws/credentials,
 * etc.) to run instead.
 */
function awsFromEnv(): ResolvedCreds["aws"] | undefined {
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  if (!region && !accessKeyId) return undefined;
  return { region: region ?? "us-east-1", accessKeyId: accessKeyId ?? "", secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "", sessionToken: process.env.AWS_SESSION_TOKEN };
}

/**
 * Reads Azure credentials from environment variables.
 * Returns undefined when neither AZURE_RESOURCE_NAME nor AZURE_API_KEY is set.
 */
function azureFromEnv(): ResolvedCreds["azure"] | undefined {
  const resourceName = process.env.AZURE_RESOURCE_NAME;
  const apiKey = process.env.AZURE_API_KEY;
  if (!resourceName && !apiKey) return undefined;
  return { resourceName: resourceName ?? "", apiKey: apiKey ?? "" };
}

/**
 * Reads Vertex AI credentials from environment variables.
 * Returns undefined when GOOGLE_VERTEX_PROJECT is not set, allowing the SDK
 * to fall through to Application Default Credentials (ADC).
 */
function vertexFromEnv(): ResolvedCreds["vertex"] | undefined {
  const project = process.env.GOOGLE_VERTEX_PROJECT;
  if (!project) return undefined;
  return { project, location: process.env.GOOGLE_VERTEX_LOCATION ?? "us-central1" };
}

/**
 * Returns true when a provider has usable credentials.
 *
 * A provider is considered available when:
 *   - At least one saved account exists for it (the durable onboarding path), OR
 *   - The provider's primary env var is set (backward-compatible fallback).
 */
export function providerAvailable(p: ProviderId): boolean {
  if (accountsForProvider(p).length > 0) return true;
  const ev = envVarFor(p);
  return ev ? Boolean(process.env[ev]) : false;
}

/**
 * The embedding seam for retrieval (context/embeddings.ts). Picks the first
 * provider with usable credentials and returns its cheapest embedding model.
 * v1 resolves keys the same way resolveModel's native fallback does (env var,
 * else the SDK's ambient lookup) — saved-account keys can layer in later.
 * Returns null when no embedding-capable provider is configured; retrieval
 * then stays pure BM25. NOT part of the routing seam: embeddings never
 * generate text, so ModelSelector is not involved.
 */
export function embeddingModelFor(): { provider: string; modelId: string; model: EmbeddingModel<string>; usdPerMtok: number } | null {
  const key = (p: string) => (envVarFor(p) ? process.env[envVarFor(p)!] : undefined);
  if (providerAvailable("openai")) {
    const apiKey = key("openai");
    const m = apiKey ? createOpenAI({ apiKey }).textEmbeddingModel("text-embedding-3-small") : openai.textEmbeddingModel("text-embedding-3-small");
    return { provider: "openai", modelId: "text-embedding-3-small", model: m, usdPerMtok: 0.02 };
  }
  if (providerAvailable("google")) {
    const apiKey = key("google");
    const m = apiKey ? createGoogleGenerativeAI({ apiKey }).textEmbeddingModel("text-embedding-004") : google.textEmbeddingModel("text-embedding-004");
    return { provider: "google", modelId: "text-embedding-004", model: m, usdPerMtok: 0 };
  }
  return null;
}

/** Finds a ModelSpec by id or label. Returns undefined if not found. */
export function findModel(idOrLabel: string): ModelSpec | undefined {
  return modelRegistry().find((m) => m.id === idOrLabel || m.label === idOrLabel);
}

/**
 * Resolves the cost for a model id, used by estimateCost.
 *
 * Lookup order:
 *   1. The spec's own cost field from the live registry.
 *   2. The model profile corpus (src/model/profiles.ts) by exact id.
 *   3. The profile corpus by the bare sdkId, so a gateway model like
 *      "openrouter/claude-opus-4-8" inherits the canonical profile price
 *      rather than falling back to $0.
 *
 * Returns undefined for discovered/gateway models with no price data.
 * Callers should treat undefined as "unknown cost", not zero.
 */
function costFor(id: string): { inUSDPerMtok: number; outUSDPerMtok: number } | undefined {
  const spec = modelRegistry().find((m) => m.id === id);
  // spec cost -> profile by id -> profile by the bare sdkId (so a gateway model like
  // "openrouter/claude-opus-4-8" still prices off the canonical profile, not $0)
  // -> canonical-family fallback (a discovered Azure deployment named after a
  // known family, e.g. "DeepSeek-V4-Pro", prices off that family's list rate).
  return (
    spec?.cost ??
    profileFor(id)?.cost ??
    (spec ? profileFor(spec.sdkId)?.cost : undefined) ??
    // The comprehensive, PROVIDER-SCOPED list-price table (src/model/pricing.ts):
    // fills the long tail and, crucially, prices a model at its HOST's rate — a
    // Foundry-hosted DeepSeek costs ~4x its native API rate, so the provider
    // scope matters for an honest estimate.
    listPriceFor(spec?.provider, spec?.sdkId ?? id) ??
    canonicalPricingFor(spec?.sdkId ?? id)
  );
}

/** The full price record (incl. cached-input rate + per-request fee) for a model
 *  id, provider-scoped — used by estimateCost for the cache-read and Sonar
 *  per-request terms. Undefined for curated/profile-priced models (they fall back
 *  to the flat cache approximation, which is what they did before). */
function priceMetaFor(id: string): Price | undefined {
  const spec = modelRegistry().find((m) => m.id === id);
  return priceFor(spec?.provider, spec?.sdkId ?? id);
}

// ── pricing fallback for discovered deployments ──────────────────────────────
// Azure/Foundry deployments and gateway ids carry NO price data from discovery,
// so cost showed "$ unknown" even when the deployment obviously serves a known
// model (the user names it "DeepSeek-V4-Pro" or "my-gpt-5.5"). Map a discovered
// name to its canonical family's list price when the match is unambiguous; stay
// honestly unknown otherwise.

// Tier/size modifiers that change a family's price (a "-mini"/"-lite" variant is
// NOT the base model): when the unmatched remainder carries one, refuse the match
// rather than bill-estimate the wrong tier.
// `codex` and `chat` are SURFACE/variant modifiers, not size tiers, but they
// equally mean "not the base model": gpt-5.5-codex (Responses, own price) must
// NOT canonical-match gpt-5.5 (chat), nor gpt-5-chat → gpt-5. (#19)
const TIER_MODIFIER = /(^|-)(mini|nano|micro|lite|small|tiny|air|turbo|ultra|flash|codex|chat)($|-)/;

/** Lowercase, dash-normalize, and strip a trailing date stamp ("-20251001",
 *  "-2025-10-01") so deployment names compare against canonical ids. Pure. */
function normalizeModelName(s: string): string {
  return s
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, "");
}

/** Best-effort canonical pricing for a discovered model/deployment id. Exact
 *  (normalized) family match first; then a boundary-anchored containment match
 *  ("team-gpt-5.5-eastus2" → gpt-5.5), longest family first so "gpt-5.5-pro"
 *  beats "gpt-5.5". Returns undefined when nothing matches — callers keep the
 *  honest "$ unknown". Pure; fixture-tested. */
export function canonicalPricingFor(sdkId: string): { inUSDPerMtok: number; outUSDPerMtok: number } | undefined {
  return canonicalSpecFor(sdkId)?.cost;
}

/** The canonical curated id a discovered deployment name maps to ("my-gpt-5.5"
 *  → "gpt-5.5"), or undefined. Routing sets this on discovered specs so quality,
 *  benchmark, and the capability floor resolve against the real model family —
 *  the difference between an Azure/Foundry/gateway deployment being routable for
 *  code and being silently excluded. Pure. */
export function canonicalIdFor(sdkId: string): string | undefined {
  return canonicalSpecFor(sdkId)?.id;
}

/** Match a deployment/sdk id to a curated model family: exact (normalized) match
 *  first; then a boundary-anchored containment match, longest family first, with
 *  the surrounding remainder forbidden from naming a different price tier. The
 *  shared core behind canonicalPricingFor + canonicalIdFor. Pure; fixture-tested. */
function canonicalSpecFor(sdkId: string): (typeof CURATED)[number] | undefined {
  const name = normalizeModelName(sdkId);
  if (!name) return undefined;
  const families = CURATED.filter((m) => NATIVE.has(m.provider) && m.cost)
    .sort((a, b) => b.id.length - a.id.length || a.id.localeCompare(b.id));
  for (const f of families) {
    const key = normalizeModelName(f.id);
    if (name === key) return f;
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?:^|[-/.:])${esc}(?:$|[-/.:])`).test(name)) {
      const rest = name.replace(new RegExp(esc), "");
      if (!TIER_MODIFIER.test(rest)) return f;
    }
  }
  return undefined;
}

/**
 * Estimates the approximate USD cost of a set of turns from per-turn usage data.
 *
 * Cache-aware: Anthropic-style usage reports cache tokens separately from
 * inputTokens, so they are priced at their real rates:
 *   - cachedInputTokens (cache reads): approximately 10% of the normal input rate.
 *   - cacheCreationInputTokens (cache writes): approximately 125% of the normal
 *     input rate (billed higher because the provider stores the KV cache).
 *
 * Flat-rate subscription seats (model ids starting with "cli:") have zero
 * marginal cost and are always skipped. Pricing them at list rates was wrong
 * because the seat fee is sunk, not per-call.
 */
/** True when we have real pricing for a model (curated/profile/discovered).
 *  Drives honest cost display: unpriced models say "unknown", never "$0.00". */
export function hasPricing(modelId: string): boolean {
  const spec = modelRegistry().find((m) => m.id === modelId);
  return !!(profileFor(modelId)?.cost ?? spec?.cost);
}

export function estimateCost(
  turns: { model: string; inputTokens: number; outputTokens: number; cachedInputTokens?: number; cacheCreationInputTokens?: number }[],
): number {
  let usd = 0;
  for (const t of turns) {
    if (t.model.startsWith("cli:")) continue; // flat-rate subscription seat
    const c = costFor(t.model);
    if (!c) continue;
    const inPerTok = c.inUSDPerMtok / 1e6;
    usd += t.inputTokens * inPerTok + (t.outputTokens / 1e6) * c.outUSDPerMtok;
    // Cache-read rate: use the model's PUBLISHED cached-input rate when the price
    // table carries one; else the flat 0.1x approximation. (N8)
    const meta = priceMetaFor(t.model);
    const cacheReadPerTok = meta?.cachedIn != null ? meta.cachedIn / 1e6 : inPerTok * 0.1;
    if (t.cachedInputTokens) usd += t.cachedInputTokens * cacheReadPerTok;
    if (t.cacheCreationInputTokens) usd += t.cacheCreationInputTokens * inPerTok * 1.25;
    // Per-request surcharge (Perplexity Sonar search fee): one request per turn
    // (a turn maps to one logical model call for the fee-bearing Sonar models). (N8)
    if (meta?.perRequestUSD) usd += meta.perRequestUSD;
  }
  return usd;
}

/**
 * Builds an AI SDK LanguageModel instance for a given spec and optional credentials.
 *
 * This is the single point where provider SDKs are instantiated. The rest of
 * the app passes the returned LanguageModel to streamText/generateText without
 * knowing which SDK produced it.
 *
 * Resolution order for credentials:
 *   1. Explicit ResolvedCreds (from a saved account, passed by the caller).
 *   2. Env-var fallback via envVarFor() (backward-compatible path).
 *   3. SDK ambient chain (AWS profile/role, Google ADC, etc.).
 *
 * Routing through providers:
 *   - AWS (authKind "aws"): createAmazonBedrock, env fallback to awsFromEnv().
 *   - Azure (authKind "azure"): createAzure, env fallback to azureFromEnv().
 *   - Vertex (authKind "vertex"): createVertex, env fallback to vertexFromEnv().
 *   - Any provider with a baseURL (non-native openai-compat, gateways, local
 *     servers): createOpenAI({ baseURL }). Adding a new provider in this
 *     category is a catalog row, not code here.
 *   - Native providers (anthropic/openai/google/deepseek): use the
 *     provider-specific SDK; fall back to the env-default singleton instance
 *     when no key is provided (backward-compat with ambient credentials).
 *   - Unknown non-native provider with no baseUrl: fall back to the OpenAI wire.
 */
export function resolveModel(spec: ModelSpec, creds?: ResolvedCreds): LanguageModel {
  const apiKey = creds?.apiKey ?? (envVarFor(spec.provider) ? process.env[envVarFor(spec.provider)!] : undefined);

  // The request CONTRACT decides which wire surface this model answers on. The
  // load-bearing case: OpenAI/Azure codex & *-pro deployments are Responses-API
  // ONLY — a chat-completions request to them returns "The requested operation
  // is unsupported." We pick `.responses()` here so the FIRST call is correct.
  // Resolve the surface from the RAW sdkId first (a real model id like
  // "gpt-5.5-codex" must win), then the canonical family — otherwise a discovered
  // "gpt-5.5-codex" whose canonicalId normalizes to the chat family "gpt-5.5"
  // would route chat and 400. Responses if EITHER says so. (#6)
  const wantsResponses =
    contractFor(spec.provider, spec.sdkId).surface === "responses" ||
    (spec.canonicalId ? contractFor(spec.provider, spec.canonicalId).surface === "responses" : false);

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
    // Bedrock's current-gen models reject on-demand invocation by bare
    // foundation-model id ("Retry your request with the ID … of an inference
    // profile") — the callable id carries a geo prefix derived from the region
    // (us. / eu. / apac.). Prefix here so the registry stays readable.
    return createAmazonBedrock(cfg)(bedrockCallableId(spec.sdkId, aws?.region));
  }
  if (creds?.azure || authKind === "azure") {
    const az = creds?.azure ?? azureFromEnv();
    const azp = createAzure(azureClientConfig({ ...az, apiKey: az?.apiKey ?? apiKey }));
    return wantsResponses ? azp.responses(spec.sdkId) : azp(spec.sdkId);
  }
  if (creds?.vertex || authKind === "vertex") {
    const vx = creds?.vertex ?? vertexFromEnv();
    // Gemini 3.x preview models are served ONLY from the `global` endpoint —
    // a regional location 404s with "Publisher Model … was not found".
    const location = /^gemini-3/.test(spec.sdkId) ? "global" : vx?.location;
    return createVertex({
      project: vx?.project,
      location,
      ...(vx?.credentials ? { googleAuthOptions: { credentials: vx.credentials } } : {}),
    })(spec.sdkId);
  }

  // OpenAI-wire path: any non-native provider routes through its catalog baseUrl
  // (account-supplied or default). One path covers ~25 providers. Use the
  // @ai-sdk/openai-COMPATIBLE provider, NOT @ai-sdk/openai:
  //   • openai's chat model bakes in OpenAI-only assumptions — for any model id
  //     it doesn't recognize as gpt-3/4/chatgpt-4o it treats the model as a
  //     "reasoning model" and sends the system prompt as role:"developer". Strict
  //     endpoints (Azure AI Foundry's grok/deepseek/kimi deployments) reject that
  //     with 422 "messages[0].role must be system|user|assistant". openai-compatible
  //     always sends role:"system" and makes no model-specific assumptions.
  //   • it POSTs to {baseURL}/chat/completions (not the Responses /responses route
  //     that calling @ai-sdk/openai as a function used to 404/405 on).
  const baseURL = creds?.baseURL ?? (NATIVE.has(spec.provider) ? undefined : catalogProvider(spec.provider)?.baseUrl);
  if (baseURL) {
    // Responses-only families (codex/*-pro on Azure AI Foundry's /openai/v1
    // surface) can't ride @ai-sdk/openai-compatible — it only POSTs to
    // /chat/completions. Route them through @ai-sdk/openai's `.responses()`
    // against the same baseURL (the /openai/v1 surface serves /responses).
    if (wantsResponses) {
      return createOpenAI({ baseURL, apiKey, headers: creds?.headers }).responses(spec.sdkId);
    }
    return createOpenAICompatible({ name: spec.provider, baseURL, apiKey, headers: creds?.headers, includeUsage: true })(spec.sdkId);
  }
  switch (spec.provider) {
    case "anthropic":
      return apiKey ? createAnthropic({ apiKey })(spec.sdkId) : anthropic(spec.sdkId);
    case "openai": {
      const oai = apiKey ? createOpenAI({ apiKey }) : openai;
      // oai(id) (provider-as-function) routes to the RESPONSES API in
      // @ai-sdk/openai v2 — so a `chat` contract must call .chat() explicitly to
      // actually POST /chat/completions. (#15)
      return wantsResponses ? oai.responses(spec.sdkId) : oai.chat(spec.sdkId);
    }
    case "google":
      return apiKey ? createGoogleGenerativeAI({ apiKey })(spec.sdkId) : google(spec.sdkId);
    case "deepseek":
      return apiKey ? createDeepSeek({ apiKey })(spec.sdkId) : deepseek(spec.sdkId);
    default:
      // Unknown non-native provider with no baseUrl — fall back to OpenAI wire
      // (chat-completions, same reasoning as above).
      return createOpenAI({ apiKey, headers: creds?.headers }).chat(spec.sdkId);
  }
}

/** Azure client config policy — pure, fixture-tested. The stored apiVersion
 *  decides the URL surface:
 *    · dated (e.g. "2024-08-01-preview") → that version + the battle-tested
 *      per-deployment URL shape;
 *    · the literal "v1" → the SDK's new /openai/v1 surface (explicit opt-in);
 *    · blank (the wizard's default) → the GA deployments API ("2024-10-21" +
 *      deployment URLs), which works on every classic resource — the previous
 *      default bet every turn on the young /openai/v1 surface and broke
 *      inference on resources that don't serve it yet. */
export const AZURE_GA_API_VERSION = "2024-10-21";
export function azureClientConfig(az?: { resourceName?: string; apiKey?: string; apiVersion?: string }): {
  resourceName?: string; apiKey?: string; apiVersion?: string; useDeploymentBasedUrls?: boolean;
} {
  const base = { resourceName: az?.resourceName, apiKey: az?.apiKey };
  const v = az?.apiVersion?.trim();
  if (v && /^\d{4}-\d{2}-\d{2}/.test(v)) return { ...base, apiVersion: v, useDeploymentBasedUrls: true };
  if (v === "v1") return base; // SDK default: /openai/v1, no apiVersion
  return { ...base, apiVersion: AZURE_GA_API_VERSION, useDeploymentBasedUrls: true };
}

/** Bedrock callable id: current-gen models are invocable only via a CROSS-
 *  REGION INFERENCE PROFILE id — the foundation id with a geo prefix matched
 *  to the account's region. Already-prefixed ids (us./eu./apac./global.) and
 *  full ARNs pass through untouched. Pure; fixture-tested. */
export function bedrockCallableId(sdkId: string, region?: string): string {
  if (/^(us|eu|apac|global)\./.test(sdkId) || sdkId.startsWith("arn:")) return sdkId;
  const r = region ?? "us-east-1";
  const geo = r.startsWith("eu-") ? "eu" : r.startsWith("ap-") ? "apac" : "us";
  return `${geo}.${sdkId}`;
}
