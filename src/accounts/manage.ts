// Azure deployment management — list, create, delete deployments on an Azure OpenAI
// or Azure AI Foundry account. Uses the same credential resolution as discover.ts.
//
// API version notes (learned the hard way, TWICE — see discover.ts and v0.2.94):
//   ALL data-plane deployment-management routes (list AND create/delete) exist only
//   on the legacy "authoring" api-versions ("2023-03-15-preview"). The modern way to
//   manage deployments is the ARM control plane (management.azure.com, AAD auth) —
//   on newer data-plane api-versions like 2024-08-01-preview the /openai/deployments
//   write routes simply DON'T EXIST and return 404 {"error":{"code":"404","message":
//   "Resource not found"}}. The account's stored apiVersion is its INFERENCE version
//   and must never be used as the primary for management routes; it survives only as
//   a fallback attempt for gateway-fronted endpoints that re-expose the routes there.
//
// OSC 8 clickable portal links: wrapped with terminalLink() so terminals that support
// them (iTerm2, Ghostty, WezTerm, kitty) make the URL clickable. Degrades gracefully.
import { resolveCreds } from "./resolve.ts";
import { armCreateDeployment, armDeleteDeployment } from "./azure-arm.ts";
import { withTimeout } from "./health.ts";
import type { Account } from "./types.ts";

const AZURE_AUTHORING_API_VERSION = "2023-03-15-preview"; // list + create + delete (legacy authoring surface)
const AZURE_LIST_API_VERSION = AZURE_AUTHORING_API_VERSION;
const AZURE_WRITE_API_VERSION_DEFAULT = "2024-08-01-preview"; // fallback attempt only
const MANAGE_TIMEOUT_MS = 15_000;
// Writes may walk the ARM control plane (subscriptions → accounts → PUT) on
// the first call — give them room; the ref is disk-cached afterwards.
const MANAGE_WRITE_TIMEOUT_MS = 45_000;

const AZURE_PROVIDERS = new Set(["azure", "azure-foundry"]);

function isAzureAccount(account: Account): boolean {
  return AZURE_PROVIDERS.has(account.provider);
}

/** Wrap a URL in an OSC 8 hyperlink so terminal-aware renderers make it clickable.
 *  The plain URL is the fallback text (always readable). */
export function terminalLink(url: string): string {
  return `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`;
}

/** The bare host of an endpoint URL ("https://x.y/z" → "x.y"). */
function hostOf(url: string): string | null {
  try { return new URL(url).host || null; } catch { return null; }
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

      let urlFor: (apiVersion: string) => string;
      let headers: Record<string, string>;

      if (creds.azure) {
        const { resourceName, apiKey } = creds.azure;
        if (!resourceName || !apiKey) return { ok: false, note: "missing resource name or key" };
        urlFor = (v) => `${azureBase(resourceName)}/openai/deployments/${encodeURIComponent(deploymentName)}?api-version=${v}`;
        headers = { "api-key": apiKey, "Content-Type": "application/json" };
      } else {
        const rawBase = creds.baseURL ?? account.baseUrl ?? "";
        if (isFoundryInferenceEndpoint(rawBase)) {
          // The inference endpoint has no management surface at all — go
          // straight to the ARM control plane (az CLI token).
          const host = hostOf(rawBase);
          if (!host) return { ok: false, note: "no endpoint configured" };
          const arm = await armCreateDeployment(host, deploymentName, modelId, capacityType, fetchImpl);
          return arm.ok ? arm : { ok: false, note: `${arm.note}\n  or create it in the portal: ${terminalLink("https://ai.azure.com")}` };
        }
        const base = foundryManagementBase(rawBase);
        if (!base) return { ok: false, note: "no endpoint configured" };
        urlFor = (v) => `${base}/openai/deployments/${encodeURIComponent(deploymentName)}?api-version=${v}`;
        headers = { "api-key": creds.apiKey ?? "", "Content-Type": "application/json", ...(creds.headers ?? {}) };
      }

      // The authoring surface wants the LEGACY body (scale_settings, lowercase
      // scale_type); sku is the modern shape for GlobalStandard/PTU. Send the
      // shape that matches each attempt's api-version.
      const legacyBody = JSON.stringify(
        capacityType === "Standard"
          ? { model: modelId, scale_settings: { scale_type: "standard" } }
          : { model: modelId, sku: { name: capacityType, capacity: capacityType === "ProvisionedManaged" ? 1 : undefined } },
      );
      const modernBody = JSON.stringify({
        model: modelId,
        scale_settings: { scale_type: capacityType },
        sku: { name: capacityType, capacity: capacityType === "ProvisionedManaged" ? 1 : undefined },
      });

      // Attempt ladder: the authoring version is where the route actually lives
      // (the stored INFERENCE version 404s — that was the v0.2.93 deploy bug).
      // The stored version survives as a fallback for gateways that re-expose
      // management routes on their inference surface.
      const storedVersion = writeApiVersion(account);
      const attempts: { v: string; body: string }[] = [{ v: AZURE_AUTHORING_API_VERSION, body: legacyBody }];
      if (storedVersion !== AZURE_AUTHORING_API_VERSION) attempts.push({ v: storedVersion, body: modernBody });

      let last: { status: number; text: string } = { status: 0, text: "" };
      for (const attempt of attempts) {
        const r = await fetchImpl(urlFor(attempt.v), { method: "PUT", headers, body: attempt.body });
        if (r.ok) return { ok: true };
        const text = await r.text().catch(() => "");
        last = { status: r.status, text };
        const portalBase = creds.azure
          ? terminalLink(`https://portal.azure.com/#resource/${creds.azure.resourceName}`)
          : "";
        if (r.status === 401) {
          return { ok: false, note: `read-only key cannot deploy — Cognitive Services Contributor role required in Azure IAM${portalBase ? "\n  manage at: " + portalBase : ""}` };
        }
        // 404 = the route doesn't exist on this api-version → try the next.
        if (r.status !== 404) {
          return { ok: false, note: `deploy failed (HTTP ${r.status}): ${text.slice(0, 200)}${portalBase ? "\n  manage at: " + portalBase : ""}` };
        }
      }
      // The data plane has no management routes here (Foundry-era accounts):
      // deployment creation is an ARM CONTROL-PLANE operation — exactly what
      // the portal calls. Do it for real via the user's az login.
      const host = creds.azure?.resourceName ? `${creds.azure.resourceName}.openai.azure.com` : hostOf(creds.baseURL ?? account.baseUrl ?? "");
      if (host) {
        const arm = await armCreateDeployment(host, deploymentName, modelId, capacityType, fetchImpl);
        if (arm.ok) return arm;
        return { ok: false, note: `the data plane on this endpoint has no deployment management (HTTP ${last.status}); tried the ARM control plane:\n  ${arm.note}` };
      }
      return { ok: false, note: `deploy failed (HTTP ${last.status}): ${last.text.slice(0, 200)}` };
    } catch (e: any) {
      return { ok: false, note: e?.message ?? "deploy failed" };
    }
  };

  return withTimeout(inner(), MANAGE_WRITE_TIMEOUT_MS, { ok: false, note: "timed out — check Azure portal for status" });
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

      let urlFor: (apiVersion: string) => string;
      let headers: Record<string, string>;

      if (creds.azure) {
        const { resourceName, apiKey } = creds.azure;
        if (!resourceName || !apiKey) return { ok: false, note: "missing resource name or key" };
        urlFor = (v) => `${azureBase(resourceName)}/openai/deployments/${encodeURIComponent(deploymentId)}?api-version=${v}`;
        headers = { "api-key": apiKey };
      } else {
        const rawBase = creds.baseURL ?? account.baseUrl ?? "";
        if (isFoundryInferenceEndpoint(rawBase)) {
          const host = hostOf(rawBase);
          if (!host) return { ok: false, note: "no endpoint configured" };
          const arm = await armDeleteDeployment(host, deploymentId, fetchImpl);
          return arm.ok ? arm : { ok: false, note: `${arm.note}\n  or delete it in the portal: ${terminalLink("https://ai.azure.com")}` };
        }
        const base = foundryManagementBase(rawBase);
        if (!base) return { ok: false, note: "no endpoint configured" };
        urlFor = (v) => `${base}/openai/deployments/${encodeURIComponent(deploymentId)}?api-version=${v}`;
        headers = { "api-key": creds.apiKey ?? "", ...(creds.headers ?? {}) };
      }

      // Same ladder as create: the authoring version is where the route lives.
      // A 404 is ambiguous — "deployment already gone" (success) vs "this route
      // doesn't exist on this api-version" (the old false-success bug). The
      // generic route miss says "Resource not found"; a real deployment miss
      // names the deployment (DeploymentNotFound). Only the latter is success.
      const storedVersion = writeApiVersion(account);
      const versions = [AZURE_AUTHORING_API_VERSION, ...(storedVersion !== AZURE_AUTHORING_API_VERSION ? [storedVersion] : [])];

      let last: { status: number; text: string } = { status: 0, text: "" };
      for (const v of versions) {
        const r = await fetchImpl(urlFor(v), { method: "DELETE", headers });
        if (r.ok) return { ok: true };
        const text = await r.text().catch(() => "");
        last = { status: r.status, text };
        const portalBase = creds.azure
          ? terminalLink(`https://portal.azure.com/#resource/${creds.azure.resourceName}`)
          : "";
        if (r.status === 404) {
          if (/deploymentnotfound|deployment .*not found/i.test(text)) return { ok: true }; // genuinely already gone
          continue; // route missing on this api-version → try the next
        }
        if (r.status === 401) {
          return { ok: false, note: `read-only key cannot delete — Cognitive Services Contributor role required in Azure IAM${portalBase ? "\n  manage at: " + portalBase : ""}` };
        }
        return { ok: false, note: `delete failed (HTTP ${r.status}): ${text.slice(0, 200)}${portalBase ? "\n  manage at: " + portalBase : ""}` };
      }
      const host = creds.azure?.resourceName ? `${creds.azure.resourceName}.openai.azure.com` : hostOf(creds.baseURL ?? account.baseUrl ?? "");
      if (host) {
        const arm = await armDeleteDeployment(host, deploymentId, fetchImpl);
        if (arm.ok) return arm;
        return { ok: false, note: `the data plane on this endpoint has no deployment management (HTTP ${last.status}); tried the ARM control plane:\n  ${arm.note}` };
      }
      return { ok: false, note: `delete failed (HTTP ${last.status}): ${last.text.slice(0, 200)}` };
    } catch (e: any) {
      return { ok: false, note: e?.message ?? "delete failed" };
    }
  };

  return withTimeout(inner(), MANAGE_WRITE_TIMEOUT_MS, { ok: false, note: "timed out — check Azure portal for status" });
}
