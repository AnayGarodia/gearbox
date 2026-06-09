// Azure deployment management — list, create, delete deployments on an Azure OpenAI
// or Azure AI Foundry account. Uses the same credential resolution as discover.ts.
//
// API version notes (learned the hard way, see discover.ts):
//   List routes use AZURE_LIST_API_VERSION ("2023-03-15-preview") — newer versions 404.
//   Create/delete use the account's stored apiVersion (default 2024-08-01-preview),
//   NOT the listing version. Write operations get the modern API surface.
//
// OSC 8 clickable portal links: wrapped with terminalLink() so terminals that support
// them (iTerm2, Ghostty, WezTerm, kitty) make the URL clickable. Degrades gracefully.
import { resolveCreds } from "./resolve.ts";
import { withTimeout } from "./health.ts";
import type { Account } from "./types.ts";

const AZURE_LIST_API_VERSION = "2023-03-15-preview";
const AZURE_WRITE_API_VERSION_DEFAULT = "2024-08-01-preview";
const MANAGE_TIMEOUT_MS = 15_000;

const AZURE_PROVIDERS = new Set(["azure", "azure-foundry"]);

function isAzureAccount(account: Account): boolean {
  return AZURE_PROVIDERS.has(account.provider);
}

/** Wrap a URL in an OSC 8 hyperlink so terminal-aware renderers make it clickable.
 *  The plain URL is the fallback text (always readable). */
export function terminalLink(url: string): string {
  return `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`;
}

/** Build the management base URL for an account (Azure or Foundry). */
function azureBase(resourceName: string): string {
  return `https://${resourceName}.openai.azure.com`;
}

/** Strip the OpenAI inference path suffix that azureFoundryBaseUrl appends
 *  ("/openai/v1", "/openai") so management API routes don't double up. */
function foundryManagementBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/openai(?:\/v1)?$/i, "");
}

/** Returns true for Azure AI Foundry project inference endpoints (*.inference.ai.azure.com).
 *  These endpoints are read-only for deployments — PUT/DELETE require ARM API with AAD auth,
 *  not the data-plane API key that in-loop accounts carry. */
function isFoundryInferenceEndpoint(baseUrl: string): boolean {
  return /\.inference\.ai\.azure\.com/i.test(baseUrl);
}

/** Pick the write api-version for an account (stored or default). */
function writeApiVersion(account: Account): string {
  if (account.auth.kind === "azure") return account.auth.apiVersion ?? AZURE_WRITE_API_VERSION_DEFAULT;
  return AZURE_WRITE_API_VERSION_DEFAULT;
}

export interface AzureDeploymentInfo {
  id: string;           // deployment name (callable id for routing)
  model: string;        // base model id (e.g. "gpt-4o")
  status: string;       // "succeeded" | "running" | "failed" | "canceled" | "notStarted"
  capacityType: string; // "Standard" | "GlobalStandard" | "ProvisionedManaged" etc.
  capacityUnits?: number; // PTUs when provisioned
}

export interface DeploymentListResult {
  ok: boolean;
  deployments: AzureDeploymentInfo[];
  note?: string;
}

export interface AvailableModelsResult {
  ok: boolean;
  models: string[];
  note?: string;
}

export interface AzureManageResult {
  ok: boolean;
  note?: string;
}

/** Parse a GET /openai/deployments response into rich deployment infos. */
export function parseDeploymentDetails(json: any): AzureDeploymentInfo[] {
  const data = Array.isArray(json?.data) ? json.data : [];
  const results: AzureDeploymentInfo[] = [];
  for (const d of data) {
    if (typeof d?.id !== "string" || !d.id) continue;
    const scale = d?.scale_settings ?? d?.sku ?? {};
    results.push({
      id: d.id,
      model: typeof d?.model === "string" ? d.model : "",
      status: typeof d?.provisioningState === "string" ? d.provisioningState.toLowerCase() :
              typeof d?.status === "string" ? d.status.toLowerCase() : "unknown",
      capacityType: typeof scale?.scale_type === "string" ? scale.scale_type :
                    typeof scale?.name === "string" ? scale.name : "Standard",
      capacityUnits: typeof scale?.capacity === "number" ? scale.capacity : undefined,
    });
  }
  return results;
}

/** Parse a GET /openai/models response into deployable model ids. */
export function parseAvailableBaseModels(json: any): string[] {
  const data = Array.isArray(json?.data) ? json.data : [];
  const ids = data
    .filter((m: any) => {
      if (typeof m?.id !== "string" || !m.id) return false;
      // Skip non-chat model families
      if (/embedding|dall-?e|whisper|tts|text-to-speech|speech|sora|moderation|transcrib|\bada\b|\bbabbage\b/i.test(m.id)) return false;
      return true;
    })
    .map((m: any) => m.id as string);
  return [...new Set(ids)] as string[];
}

/**
 * List current deployments with status and capacity details.
 * Returns empty for non-Azure accounts (no-op).
 * Never throws — failures return { ok: false, note }.
 */
export async function listDeploymentDetails(
  account: Account,
  fetchImpl: typeof fetch = fetch,
): Promise<DeploymentListResult> {
  if (!isAzureAccount(account)) return { ok: true, deployments: [] };

  const inner = async (): Promise<DeploymentListResult> => {
    try {
      const creds = await resolveCreds(account);

      if (creds.azure) {
        const { resourceName, apiKey } = creds.azure;
        if (!resourceName || !apiKey) return { ok: false, deployments: [], note: "missing resource name or key" };
        const url = `${azureBase(resourceName)}/openai/deployments?api-version=${AZURE_LIST_API_VERSION}`;
        const r = await fetchImpl(url, { headers: { "api-key": apiKey } });
        if (!r.ok) {
          const note = r.status === 401
            ? "invalid or expired API key"
            : `HTTP ${r.status}`;
          return { ok: false, deployments: [], note };
        }
        return { ok: true, deployments: parseDeploymentDetails(await r.json()) };
      }

      // Foundry path
      const base = creds.baseURL ?? account.baseUrl;
      if (base) {
        const cleanBase = foundryManagementBase(base);
        const r = await fetchImpl(`${cleanBase}/openai/deployments?api-version=${AZURE_LIST_API_VERSION}`, {
          headers: { "api-key": creds.apiKey ?? "", ...(creds.headers ?? {}) },
        });
        if (!r.ok) {
          const note = r.status === 401
            ? "invalid or expired API key"
            : `HTTP ${r.status}`;
          return { ok: false, deployments: [], note };
        }
        return { ok: true, deployments: parseDeploymentDetails(await r.json()) };
      }

      return { ok: false, deployments: [], note: "no endpoint configured" };
    } catch (e: any) {
      return { ok: false, deployments: [], note: e?.message ?? "fetch failed" };
    }
  };

  return withTimeout(inner(), MANAGE_TIMEOUT_MS, { ok: false, deployments: [], note: "timed out after 15s — check endpoint URL" });
}

/**
 * List the base models available to deploy on this account.
 * Returns empty for non-Azure accounts.
 * Never throws.
 */
export async function listAvailableModels(
  account: Account,
  fetchImpl: typeof fetch = fetch,
): Promise<AvailableModelsResult> {
  if (!isAzureAccount(account)) return { ok: true, models: [] };

  const inner = async (): Promise<AvailableModelsResult> => {
    try {
      const creds = await resolveCreds(account);

      if (creds.azure) {
        const { resourceName, apiKey } = creds.azure;
        if (!resourceName || !apiKey) return { ok: false, models: [], note: "missing resource name or key" };
        const url = `${azureBase(resourceName)}/openai/models?api-version=${AZURE_LIST_API_VERSION}`;
        const r = await fetchImpl(url, { headers: { "api-key": apiKey } });
        if (!r.ok) return { ok: false, models: [], note: `HTTP ${r.status}` };
        return { ok: true, models: parseAvailableBaseModels(await r.json()) };
      }

      const base = creds.baseURL ?? account.baseUrl;
      if (base) {
        const cleanBase = foundryManagementBase(base);
        const r = await fetchImpl(`${cleanBase}/openai/models?api-version=${AZURE_LIST_API_VERSION}`, {
          headers: { "api-key": creds.apiKey ?? "", ...(creds.headers ?? {}) },
        });
        if (!r.ok) return { ok: false, models: [], note: `HTTP ${r.status}` };
        return { ok: true, models: parseAvailableBaseModels(await r.json()) };
      }

      return { ok: false, models: [], note: "no endpoint configured" };
    } catch (e: any) {
      return { ok: false, models: [], note: e?.message ?? "fetch failed" };
    }
  };

  return withTimeout(inner(), MANAGE_TIMEOUT_MS, { ok: false, models: [], note: "timed out after 15s" });
}

/**
 * Create (deploy) a model on an Azure account.
 * Uses the account's stored apiVersion for the write path.
 * Never throws.
 */
export async function createDeployment(
  account: Account,
  deploymentName: string,
  modelId: string,
  capacityType: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AzureManageResult> {
  if (!isAzureAccount(account)) return { ok: false, note: "not an Azure account" };

  const inner = async (): Promise<AzureManageResult> => {
    try {
      const creds = await resolveCreds(account);
      const apiVersion = writeApiVersion(account);
      const body = JSON.stringify({
        model: modelId,
        scale_settings: { scale_type: capacityType },
        sku: { name: capacityType, capacity: capacityType === "ProvisionedManaged" ? 1 : undefined },
      });

      let url: string;
      let headers: Record<string, string>;

      if (creds.azure) {
        const { resourceName, apiKey } = creds.azure;
        if (!resourceName || !apiKey) return { ok: false, note: "missing resource name or key" };
        url = `${azureBase(resourceName)}/openai/deployments/${encodeURIComponent(deploymentName)}?api-version=${apiVersion}`;
        headers = { "api-key": apiKey, "Content-Type": "application/json" };
      } else {
        const rawBase = creds.baseURL ?? account.baseUrl ?? "";
        if (isFoundryInferenceEndpoint(rawBase)) {
          return { ok: false, note: "deployment creation requires the Azure AI Foundry portal — inference endpoint API keys don't have management permissions\n  open: https://ai.azure.com" };
        }
        const base = foundryManagementBase(rawBase);
        if (!base) return { ok: false, note: "no endpoint configured" };
        url = `${base}/openai/deployments/${encodeURIComponent(deploymentName)}?api-version=${apiVersion}`;
        headers = { "api-key": creds.apiKey ?? "", "Content-Type": "application/json", ...(creds.headers ?? {}) };
      }

      const r = await fetchImpl(url, { method: "PUT", headers, body });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        const portalBase = creds.azure
          ? terminalLink(`https://portal.azure.com/#resource/${creds.azure.resourceName}`)
          : "";
        if (r.status === 401) {
          return { ok: false, note: `read-only key cannot deploy — Cognitive Services Contributor role required in Azure IAM${portalBase ? "\n  manage at: " + portalBase : ""}` };
        }
        return { ok: false, note: `deploy failed (HTTP ${r.status}): ${text.slice(0, 200)}${portalBase ? "\n  manage at: " + portalBase : ""}` };
      }
      return { ok: true };
    } catch (e: any) {
      return { ok: false, note: e?.message ?? "deploy failed" };
    }
  };

  return withTimeout(inner(), MANAGE_TIMEOUT_MS, { ok: false, note: "timed out — check Azure portal for status" });
}

/**
 * Delete a deployment from an Azure account.
 * 404 (already gone) is treated as success.
 * Never throws.
 */
export async function deleteDeployment(
  account: Account,
  deploymentId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AzureManageResult> {
  if (!isAzureAccount(account)) return { ok: false, note: "not an Azure account" };

  const inner = async (): Promise<AzureManageResult> => {
    try {
      const creds = await resolveCreds(account);
      const apiVersion = writeApiVersion(account);

      let url: string;
      let headers: Record<string, string>;

      if (creds.azure) {
        const { resourceName, apiKey } = creds.azure;
        if (!resourceName || !apiKey) return { ok: false, note: "missing resource name or key" };
        url = `${azureBase(resourceName)}/openai/deployments/${encodeURIComponent(deploymentId)}?api-version=${apiVersion}`;
        headers = { "api-key": apiKey };
      } else {
        const rawBase = creds.baseURL ?? account.baseUrl ?? "";
        if (isFoundryInferenceEndpoint(rawBase)) {
          return { ok: false, note: "deployment deletion requires the Azure AI Foundry portal — inference endpoint API keys don't have management permissions\n  open: https://ai.azure.com" };
        }
        const base = foundryManagementBase(rawBase);
        if (!base) return { ok: false, note: "no endpoint configured" };
        url = `${base}/openai/deployments/${encodeURIComponent(deploymentId)}?api-version=${apiVersion}`;
        headers = { "api-key": creds.apiKey ?? "", ...(creds.headers ?? {}) };
      }

      const r = await fetchImpl(url, { method: "DELETE", headers });
      if (r.status === 404) return { ok: true }; // already gone — treat as success
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        const portalBase = creds.azure
          ? terminalLink(`https://portal.azure.com/#resource/${creds.azure.resourceName}`)
          : "";
        if (r.status === 401) {
          return { ok: false, note: `read-only key cannot delete — Cognitive Services Contributor role required in Azure IAM${portalBase ? "\n  manage at: " + portalBase : ""}` };
        }
        return { ok: false, note: `delete failed (HTTP ${r.status}): ${text.slice(0, 200)}${portalBase ? "\n  manage at: " + portalBase : ""}` };
      }
      return { ok: true };
    } catch (e: any) {
      return { ok: false, note: e?.message ?? "delete failed" };
    }
  };

  return withTimeout(inner(), MANAGE_TIMEOUT_MS, { ok: false, note: "timed out — check Azure portal for status" });
}
