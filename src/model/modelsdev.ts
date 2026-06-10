// ── MODELS.DEV CATALOG SYNC ───────────────────────────────────────────────────
// Self-contained sync against https://models.dev/api.json — an open, community-
// maintained catalog of ~140 providers × ~5k models with pricing, context
// limits, and capability flags. This module fetches it, normalizes it into
// gearbox-shaped entries, and caches it on disk so the router can discover
// models we never curated by hand — WITHOUT touching the curated registry
// (curated models always win; see mergeIntoRegistry).
//
// Observed api.json shape (verified live 2026-06-10):
//
//   {
//     [providerId: string]: {
//       id: string, name: string,
//       env?: string[], npm?: string, doc?: string, api?: string,
//       models: {
//         [modelId: string]: {
//           id: string, name: string, family?: string,
//           attachment: boolean,      // file/attachment input support
//           reasoning: boolean,       // thinking/reasoning support
//           tool_call: boolean,       // function calling
//           temperature?: boolean, structured_output?: boolean,
//           reasoning_options?: Array<{ type: string, ... }>,
//           knowledge?: string, release_date?: string, last_updated?: string,
//           modalities?: { input: string[], output: string[] },
//           open_weights?: boolean, status?: string,   // e.g. "deprecated"
//           limit: { context: number, output: number, input?: number },
//           cost?: {                  // $/Mtok; ABSENT on free/local models
//             input: number, output: number,
//             cache_read?: number, cache_write?: number,
//             reasoning?: number, input_audio?: number, output_audio?: number,
//             context_over_200k?: object, tiers?: unknown,
//           },
//         }
//       }
//     }
//   }
//
// No I/O happens in parseModelsDev/mergeIntoRegistry (pure, fixture-tested);
// the network and disk paths (fetchModelsDev, load/saveCachedCatalog,
// syncModelsDev) never throw — every failure degrades to null / stale cache /
// empty, matching the "a missing signal is neutral" routing principle.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── types ─────────────────────────────────────────────────────────────────────

/** Raw https://models.dev/api.json document: provider id → provider record. */
export type ModelsDevCatalog = Record<string, ModelsDevProvider>;

export interface ModelsDevProvider {
  id?: string;
  name?: string;
  env?: string[];
  npm?: string;
  doc?: string;
  api?: string;
  models?: Record<string, ModelsDevModel>;
}

/** Raw model record as served by models.dev (fields we read; the rest tolerated). */
export interface ModelsDevModel {
  id?: string;
  name?: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; output?: number; input?: number };
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
    [extra: string]: unknown;
  };
  [extra: string]: unknown;
}

/** Normalized, gearbox-shaped catalog entry. Costs are $/Mtok (same unit upstream). */
export interface ModelsDevEntry {
  provider: string; // gearbox catalog provider id (mapped; see PROVIDER_ID_MAP)
  id: string; // model id as the provider's API expects it (= registry sdkId)
  label: string; // human name ("Claude Opus 4.5 (latest)"), falls back to id
  contextWindow?: number;
  maxOutput?: number;
  cost?: { inUSDPerMtok: number; outUSDPerMtok: number; cacheReadUSDPerMtok?: number };
  tools?: boolean; // tool/function calling
  images?: boolean; // accepts image input
  reasoning?: boolean; // thinking/reasoning support
}

// ── provider id mapping ───────────────────────────────────────────────────────
// models.dev provider id → gearbox catalog id (src/accounts/catalog.ts).
// Verified against both sides 2026-06-10 (models.dev `env` vars match the
// gearbox catalog rows, e.g. models.dev "vercel" carries AI_GATEWAY_API_KEY =
// gearbox "vercel-gateway").
//
//   models.dev id            gearbox id        evidence
//   ─────────────────────    ───────────────   ─────────────────────────────────
//   amazon-bedrock        →  bedrock           AWS_ACCESS_KEY_ID/... env match
//   google-vertex         →  vertex            GOOGLE_VERTEX_PROJECT env match
//   google-vertex-anthropic→ vertex            same Vertex creds (Claude-on-Vertex)
//   togetherai            →  together          TOGETHER_API_KEY env match
//   fireworks-ai          →  fireworks         FIREWORKS_API_KEY env match
//   moonshotai            →  moonshot          MOONSHOT_API_KEY env match
//   novita-ai             →  novita            NOVITA_API_KEY env match
//   vercel                →  vercel-gateway    name "Vercel AI Gateway", AI_GATEWAY_API_KEY
//
// Identical on both sides (pass through unchanged): anthropic, openai, google,
// deepseek, xai, mistral, groq, deepinfra, cerebras, perplexity, baseten, zai,
// nebius, minimax, openrouter, requesty, azure, lmstudio.
//
// Deliberately NOT mapped:
//   - zhipuai: bigmodel.cn endpoint; gearbox "zai" targets api.z.ai — mapping
//     both would collide the same GLM model ids under one provider.
//   - ollama-cloud: hosted service; gearbox "ollama" is the localhost server.
//   - azure-cognitive-services and the regional/plan variants (*-cn,
//     *-coding-plan): distinct endpoints/credentials gearbox has no row for.
// Unknown providers pass through with their models.dev id unchanged — harmless,
// since entries only become routable when a gearbox account serves that id.
export const PROVIDER_ID_MAP: Record<string, string> = {
  "amazon-bedrock": "bedrock",
  "google-vertex": "vertex",
  "google-vertex-anthropic": "vertex",
  togetherai: "together",
  "fireworks-ai": "fireworks",
  moonshotai: "moonshot",
  "novita-ai": "novita",
  vercel: "vercel-gateway",
};

/** Map a models.dev provider id to the gearbox catalog id (identity when unmapped). */
export function mapProviderId(modelsDevId: string): string {
  return PROVIDER_ID_MAP[modelsDevId] ?? modelsDevId;
}

// ── fetch ─────────────────────────────────────────────────────────────────────

export const MODELS_DEV_URL = "https://models.dev/api.json";
const FETCH_TIMEOUT_MS = 10_000;

/**
 * GET https://models.dev/api.json with a 10s timeout. Returns the raw catalog
 * object, or null on ANY failure (network, timeout, non-2xx, bad JSON) —
 * never throws. `fetchImpl` is injectable for tests.
 */
export async function fetchModelsDev(fetchImpl: typeof fetch = fetch): Promise<ModelsDevCatalog | null> {
  try {
    const res = await fetchImpl(MODELS_DEV_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const json: unknown = await res.json();
    if (!isRecord(json)) return null;
    return json as ModelsDevCatalog;
  } catch {
    return null;
  }
}

// ── parse (pure) ──────────────────────────────────────────────────────────────

/**
 * Normalize a raw models.dev document into ModelsDevEntry[]. Pure and totally
 * defensive: anything malformed (non-object providers/models, missing ids,
 * non-numeric costs/limits) is skipped or omitted field-by-field, never thrown.
 * Models without a `cost` block (free/local/open-weight listings) keep
 * `cost: undefined` so downstream scoring treats them as unknown, not $0.
 */
export function parseModelsDev(json: unknown): ModelsDevEntry[] {
  if (!isRecord(json)) return [];
  const entries: ModelsDevEntry[] = [];
  for (const [providerKey, providerRaw] of Object.entries(json)) {
    if (!isRecord(providerRaw)) continue;
    const models = providerRaw.models;
    if (!isRecord(models)) continue;
    const provider = mapProviderId(typeof providerRaw.id === "string" && providerRaw.id ? providerRaw.id : providerKey);
    for (const [modelKey, m] of Object.entries(models)) {
      if (!isRecord(m)) continue;
      const id = typeof m.id === "string" && m.id ? m.id : modelKey;
      if (!id) continue;
      const label = typeof m.name === "string" && m.name ? m.name : id;

      const entry: ModelsDevEntry = { provider, id, label };

      const limit = isRecord(m.limit) ? m.limit : undefined;
      const context = posNum(limit?.context);
      const output = posNum(limit?.output);
      if (context !== undefined) entry.contextWindow = context;
      if (output !== undefined) entry.maxOutput = output;

      // cost.input/output are $/Mtok upstream — same unit as the gearbox
      // registry, so they map 1:1. Both must be present for the block to count.
      const cost = isRecord(m.cost) ? m.cost : undefined;
      const inUSD = nonNegNum(cost?.input);
      const outUSD = nonNegNum(cost?.output);
      if (inUSD !== undefined && outUSD !== undefined) {
        entry.cost = { inUSDPerMtok: inUSD, outUSDPerMtok: outUSD };
        const cacheRead = nonNegNum(cost?.cache_read);
        if (cacheRead !== undefined) entry.cost.cacheReadUSDPerMtok = cacheRead;
      }

      if (typeof m.tool_call === "boolean") entry.tools = m.tool_call;
      if (typeof m.reasoning === "boolean") entry.reasoning = m.reasoning;

      // Image input: modalities.input is the precise signal; `attachment` is the
      // coarser fallback (file/attachment support) when modalities are absent.
      const inputs = isRecord(m.modalities) && Array.isArray(m.modalities.input) ? m.modalities.input : undefined;
      if (inputs) entry.images = inputs.includes("image");
      else if (typeof m.attachment === "boolean") entry.images = m.attachment;

      entries.push(entry);
    }
  }
  return entries;
}

// ── merge (pure) ──────────────────────────────────────────────────────────────

/**
 * Return only the entries NOT already present in the curated registry, deduped
 * by provider+id (registry entries are keyed provider+sdkId). Curated models
 * always win — a models.dev row for a model we hand-curated is dropped, so the
 * curated pricing/profile is never shadowed. Duplicate (provider, id) pairs
 * within `entries` themselves are also collapsed (first wins) so the result is
 * safe to append to a registry wholesale.
 */
export function mergeIntoRegistry(
  entries: ModelsDevEntry[],
  existing: { provider: string; sdkId: string }[],
): ModelsDevEntry[] {
  const seen = new Set(existing.map((e) => pairKey(e.provider, e.sdkId)));
  const out: ModelsDevEntry[] = [];
  for (const entry of entries) {
    const key = pairKey(entry.provider, entry.id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

// ── disk cache ────────────────────────────────────────────────────────────────

export interface CachedCatalog {
  fetchedAt: number; // epoch ms
  entries: ModelsDevEntry[];
}

const CACHE_FILE = "models-dev.json";
const home = () => process.env.GEARBOX_HOME || join(homedir(), ".gearbox");
const cachePath = () => join(home(), CACHE_FILE);

/** Read the cached catalog from ${GEARBOX_HOME|~/.gearbox}/models-dev.json; null if absent/corrupt. */
export function loadCachedCatalog(): CachedCatalog | null {
  try {
    const raw = JSON.parse(readFileSync(cachePath(), "utf8")) as unknown;
    if (!isRecord(raw)) return null;
    if (typeof raw.fetchedAt !== "number" || !Array.isArray(raw.entries)) return null;
    return { fetchedAt: raw.fetchedAt, entries: raw.entries as ModelsDevEntry[] };
  } catch {
    return null;
  }
}

/** Persist entries (stamped fetchedAt=now). Best-effort: failures are swallowed. */
export function saveCachedCatalog(entries: ModelsDevEntry[]): void {
  try {
    mkdirSync(home(), { recursive: true });
    const record: CachedCatalog = { fetchedAt: Date.now(), entries };
    // Temp-write + rename (atomic in the same dir) — a torn write would leave a
    // corrupt cache that loadCachedCatalog silently discards every boot.
    const tmp = `${cachePath()}.tmp`;
    writeFileSync(tmp, JSON.stringify(record));
    renameSync(tmp, cachePath());
  } catch {
    // best-effort cache; never let a disk failure break the caller
  }
}

// ── sync ──────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The one-call entry point: return a fresh-enough catalog.
 *  1. cache younger than maxAgeMs → cached entries (no network)
 *  2. else fetch + parse + save → fresh entries
 *  3. fetch failed (offline) → stale cache if any, else []
 * Never throws. `fetchImpl` is injectable for tests.
 */
export async function syncModelsDev(
  opts: { maxAgeMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<ModelsDevEntry[]> {
  const maxAgeMs = opts.maxAgeMs ?? DAY_MS;
  const cached = loadCachedCatalog();
  if (cached && Date.now() - cached.fetchedAt < maxAgeMs) return cached.entries;

  const raw = await fetchModelsDev(opts.fetchImpl ?? fetch);
  if (raw) {
    const entries = parseModelsDev(raw);
    saveCachedCatalog(entries);
    return entries;
  }
  return cached?.entries ?? [];
}

// ── helpers ───────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function posNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

function nonNegNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

// " " (verified live) never appears in provider/model ids, so the joined key is collision-free for dedupe purposes.
function pairKey(provider: string, id: string): string {
  return `${provider} ${id}`;
}
