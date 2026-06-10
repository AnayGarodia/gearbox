// Model discovery — ask a provider which models the ACCOUNT can actually call,
// instead of advertising the catalog's seed ids (which are guesses). This is the
// fix for "the listed model 404s": for Azure the callable id is a user-named
// deployment; for Foundry/gateways it's whatever the endpoint serves. The seeds
// in catalog.ts are examples, not a contract — discovery replaces them with the
// real set, persisted onto `account.models` (consumed by providers.accountModelSpecs).
//
// Endpoints (learned the hard way, see the why-notes):
//   - Azure OpenAI: GET {endpoint}/openai/deployments?api-version=2023-03-15-preview
//     The *listing* route only answers on that api-version; newer versions 404
//     (they're per-deployment inference routes). Callable id = the deployment id.
//   - Azure AI Foundry / openai-compat / gateways / local: GET {baseURL}/models
//     (OpenAI-wire). Foundry/Azure annotate each model with `capabilities`, so we
//     keep only chat-capable, non-deprecated ones; plain endpoints list all ids.
import { resolveCreds } from "./resolve.ts";
import { catalogProvider } from "./catalog.ts";
import type { Account } from "./types.ts";

// The Azure *deployment listing* api-version. Distinct from the inference
// api-version stored on the account (auth.apiVersion) — the list route 404s on
// the newer ones, so discovery pins this regardless of the account setting.
const AZURE_LIST_API_VERSION = "2023-03-15-preview";

const NATIVE = new Set(["anthropic", "openai", "google", "deepseek"]);

// Model families that aren't text-chat (so we don't offer an embeddings or
// image deployment as a chat model). Matched against the deployment's model id.
const NON_CHAT = /embedding|dall-?e|whisper|tts|text-to-speech|speech|sora|moderation|transcrib|\bada\b|\bbabbage\b/i;

export interface DiscoverResult {
  ok: boolean;
  models: string[];
  note?: string;
}

/** Status-specific note for an Azure deployments-list failure — "HTTP 401" and
 *  "HTTP 404" need OPPOSITE fixes, so a generic message left users stuck. Pure. */
export function azureListNote(status: number, provider: "azure" | "azure-foundry"): string {
  if (status === 401) return "key rejected (HTTP 401) — re-check the key in portal → Keys and Endpoint · fix it, then /account refresh";
  if (status === 403) return "key valid but blocked (HTTP 403) — resource firewall/VNet rules or a missing data-plane role · fix it, then /account refresh";
  if (status === 404 && provider === "azure") {
    return "resource not found (HTTP 404) — wrong resource name, or this is a Foundry endpoint: re-add with /account add azure https://<endpoint> <key>";
  }
  return `deployments list failed (HTTP ${status}) · fix it, then /account refresh`;
}

// The actionable empty-deployments note — names the in-app next step.
const NO_DEPLOYMENTS_NOTE = "no chat deployments yet — press → on this account in /account to deploy a model (or ai.azure.com), then /account refresh";

/** Azure deployment list (`/openai/deployments`) → callable chat deployment ids. */
export function parseAzureDeployments(json: any): string[] {
  const data = Array.isArray(json?.data) ? json.data : [];
  const ids = data
    .filter((d: any) => !(typeof d?.model === "string" && NON_CHAT.test(d.model)))
    .map((d: any) => d?.id)
    .filter((x: any): x is string => typeof x === "string" && x.length > 0);
  return [...new Set(ids)] as string[];
}

/** OpenAI-wire `/models` → ids. When the endpoint annotates capabilities (Azure
 *  Foundry), keep only chat-capable, non-deprecated models; otherwise keep all. */
export function parseOpenAIModels(json: any): string[] {
  const data = Array.isArray(json?.data) ? json.data : [];
  const ids = data
    .filter((m: any) => {
      const cap = m?.capabilities;
      if (cap && typeof cap.chat_completion === "boolean") {
        return cap.chat_completion && m?.lifecycle_status !== "deprecated";
      }
      return true; // plain OpenAI-style endpoint: no capability hints, keep all
    })
    .map((m: any) => m?.id)
    .filter((x: any): x is string => typeof x === "string" && x.length > 0);
  return [...new Set(ids)] as string[];
}

/**
 * Discover the models an account can actually serve. Network is injectable
 * (`fetchImpl`) so it's unit-testable. Never throws — failures come back as
 * `{ ok: false, note }` so callers can keep the account and just skip the list.
 */
export async function discoverModels(account: Account, fetchImpl: typeof fetch = fetch): Promise<DiscoverResult> {
  // Native providers have a curated, guaranteed registry; cli runs via subprocess.
  if (NATIVE.has(account.provider) || account.exec === "cli") return { ok: true, models: [] };
  // Providers with no /models route (catalog noModelsEndpoint, e.g. Perplexity):
  // discovery would always 404 — the seeded defaultModels ARE the list.
  if (catalogProvider(account.provider)?.noModelsEndpoint) return { ok: true, models: [] };

  try {
    const creds = await resolveCreds(account);

    // Azure OpenAI: list deployments (callable ids), pinned to the list route's api-version.
    if (creds.azure) {
      const { resourceName, apiKey } = creds.azure;
      if (!resourceName || !apiKey) return { ok: false, models: [], note: "azure: missing resource name or key" };
      const url = `https://${resourceName}.openai.azure.com/openai/deployments?api-version=${AZURE_LIST_API_VERSION}`;
      const r = await fetchImpl(url, { headers: { "api-key": apiKey } });
      if (!r.ok) return { ok: false, models: [], note: azureListNote(r.status, "azure") };
      const models = parseAzureDeployments(await r.json());
      return { ok: true, models, note: models.length ? undefined : NO_DEPLOYMENTS_NOTE };
    }

    // OpenAI-wire path (Foundry, gateways, openai-compat, local servers).
    const base = creds.baseURL ?? catalogProvider(account.provider)?.baseUrl;
    if (base) {
      // Strip inference path suffix (/openai/v1 or /openai) that Foundry baseUrls
      // carry, so management routes don't double up the path segment.
      const mgmtBase = base.replace(/\/+$/, "").replace(/\/openai(?:\/v1)?$/i, "");
      const cleanBase = base.replace(/\/$/, "");
      // Azure AI Foundry supports the same /openai/deployments listing route as
      // classic Azure. It returns *actual* deployments (not the whole catalog),
      // so it is AUTHORITATIVE for Foundry accounts: an OK answer — even an
      // empty one — must be trusted. Falling through to /models on an empty
      // list used to persist the resource's whole deployable CATALOG (hundreds
      // of ids) as callable models, every one of which 404s at inference. Only
      // a missing route (404/network) may fall back; 401/403 is a credential
      // problem the catalog dump would mask.
      if (account.provider === "azure-foundry" && creds.apiKey) {
        try {
          const depUrl = `${mgmtBase}/openai/deployments?api-version=${AZURE_LIST_API_VERSION}`;
          const dr = await fetchImpl(depUrl, { headers: { "api-key": creds.apiKey } });
          if (dr.ok) {
            const models = parseAzureDeployments(await dr.json());
            return { ok: true, models, note: models.length ? undefined : NO_DEPLOYMENTS_NOTE };
          }
          if (dr.status === 401 || dr.status === 403) {
            return { ok: false, models: [], note: azureListNote(dr.status, "azure-foundry") };
          }
          // Route genuinely absent (e.g. 404 on a non-Foundry-shaped endpoint):
          // fall through to /models below.
        } catch {
          // fall through to /models
        }
      }
      const r = await fetchImpl(`${cleanBase}/models`, { headers: { Authorization: `Bearer ${creds.apiKey ?? ""}`, ...(creds.headers ?? {}) } });
      if (!r.ok) return { ok: false, models: [], note: `models endpoint returned HTTP ${r.status}` };
      const models = parseOpenAIModels(await r.json());
      return { ok: true, models };
    }

    return { ok: true, models: [] };
  } catch (e: any) {
    const msg = String(e?.message ?? "");
    if (/ENOTFOUND|getaddrinfo|Unable to connect|fetch failed/i.test(msg)) {
      return { ok: false, models: [], note: "endpoint not found — check the resource name / endpoint URL · fix it, then /account refresh" };
    }
    return { ok: false, models: [], note: msg || "discovery failed" };
  }
}
