// Azure ARM control plane — the path that ACTUALLY creates deployments.
// Data-plane API keys can list deployments, but creating/deleting them is a
// management operation (Microsoft.CognitiveServices/accounts/deployments on
// management.azure.com) that requires an Azure AD token — it's what the portal
// itself calls. We get the token from the user's own `az` CLI (no secret ever
// stored), locate the account behind the endpoint, and PUT through ARM.
// Every failure names its fix; nothing here throws.
import { spawnSyncProc, which } from "../proc.ts";
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const ARM = "https://management.azure.com";
const ARM_API = "2024-10-01"; // Microsoft.CognitiveServices GA surface

export interface ArmAccountRef {
  id: string; // full ARM resource id (/subscriptions/…/accounts/<name>)
  name: string;
  subscriptionId: string;
  resourceGroup: string;
  endpoint: string; // the data-plane endpoint host this account serves
}

export interface ArmResult {
  ok: boolean;
  note?: string;
}

// ── az CLI token (cached until ~5 min before expiry) ─────────────────────────

let tokenCache: { token: string; expiresAt: number } | null = null;

export function armToken(execImpl: typeof spawnSyncProc = spawnSyncProc): { token: string } | { error: string } {
  if (process.env.GEARBOX_DISABLE_AZ === "1") {
    return { error: "ARM management is disabled (GEARBOX_DISABLE_AZ=1) — create the deployment in the portal" };
  }
  if (tokenCache && Date.now() < tokenCache.expiresAt - 5 * 60_000) return { token: tokenCache.token };
  if (!which("az")) {
    return { error: "deployment management needs the Azure CLI — install az (brew install azure-cli), then az login" };
  }
  const r = execImpl(["az", "account", "get-access-token", "--resource", ARM, "--output", "json"], { stdout: "pipe", stderr: "pipe" });
  if ((r.exitCode ?? 1) !== 0) {
    const err = r.stderr.toString().trim().split("\n")[0] ?? "";
    return { error: `az couldn't issue a management token — run az login${err ? ` (${err.slice(0, 120)})` : ""}` };
  }
  try {
    const j = JSON.parse(r.stdout.toString());
    const token = String(j.accessToken ?? "");
    if (!token) return { error: "az returned no token — run az login" };
    const expiresAt = j.expires_on ? Number(j.expires_on) * 1000 : Date.parse(j.expiresOn ?? "") || Date.now() + 30 * 60_000;
    tokenCache = { token, expiresAt };
    return { token };
  } catch {
    return { error: "couldn't parse az's token output — run az login and retry" };
  }
}

/** Test/reset hook. */
export function clearArmCaches(): void {
  tokenCache = null;
}

// ── locating the account behind an endpoint ──────────────────────────────────
// ARM ids carry the resource group: /subscriptions/<sub>/resourceGroups/<rg>/
// providers/Microsoft.CognitiveServices/accounts/<name>. Pure parser, tested.

export function parseArmId(id: string): { subscriptionId: string; resourceGroup: string; name: string } | null {
  const m = id.match(/^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.CognitiveServices\/accounts\/([^/]+)$/i);
  return m ? { subscriptionId: m[1]!, resourceGroup: m[2]!, name: m[3]! } : null;
}

/** Match an ARM account record to the endpoint host gearbox calls. Accounts
 *  expose several hostnames (openai.azure.com, services.ai.azure.com,
 *  cognitiveservices.azure.com) that share the resource name as the subdomain,
 *  so the subdomain is the join key. Pure, tested. */
export function accountMatchesHost(acct: { name?: string; properties?: { endpoint?: string; endpoints?: Record<string, string> } }, host: string): boolean {
  const sub = host.split(".")[0]?.toLowerCase();
  if (acct.name && sub && acct.name.toLowerCase() === sub) return true;
  const eps = [acct.properties?.endpoint, ...Object.values(acct.properties?.endpoints ?? {})].filter(Boolean) as string[];
  return eps.some((e) => {
    try { return new URL(e).host.toLowerCase() === host.toLowerCase(); } catch { return false; }
  });
}

const cacheFile = () => join(process.env.GEARBOX_HOME || join(homedir(), ".gearbox"), "azure-arm.json");

function readRefCache(): Record<string, ArmAccountRef> {
  try { return JSON.parse(readFileSync(cacheFile(), "utf8")); } catch { return {}; }
}

function writeRefCache(map: Record<string, ArmAccountRef>): void {
  try {
    mkdirSync(join(cacheFile(), ".."), { recursive: true });
    writeFileSync(`${cacheFile()}.tmp`, JSON.stringify(map, null, 2), { mode: 0o600 });
    renameSync(`${cacheFile()}.tmp`, cacheFile());
  } catch { /* best-effort cache */ }
}

async function armGet(token: string, path: string, fetchImpl: typeof fetch): Promise<any | null> {
  try {
    const r = await fetchImpl(`${ARM}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/** Find the Cognitive Services account serving `endpointHost`, scanning every
 *  subscription the az login can see. Cached on disk per host (finding it
 *  walks subscriptions — slow; calling it twice shouldn't be). */
export async function findAccountForHost(endpointHost: string, fetchImpl: typeof fetch = fetch, execImpl: typeof spawnSyncProc = spawnSyncProc): Promise<ArmAccountRef | { error: string }> {
  const cached = readRefCache()[endpointHost.toLowerCase()];
  if (cached) return cached;
  const t = armToken(execImpl);
  if ("error" in t) return t;
  const subs = await armGet(t.token, `/subscriptions?api-version=2022-12-01`, fetchImpl);
  const subIds: string[] = (subs?.value ?? []).map((s: any) => s.subscriptionId).filter(Boolean);
  if (!subIds.length) return { error: "az sees no Azure subscriptions — az login with the account that owns this resource" };
  for (const sub of subIds) {
    const accounts = await armGet(t.token, `/subscriptions/${sub}/providers/Microsoft.CognitiveServices/accounts?api-version=${ARM_API}`, fetchImpl);
    for (const a of accounts?.value ?? []) {
      if (!accountMatchesHost(a, endpointHost)) continue;
      const parsed = parseArmId(String(a.id ?? ""));
      if (!parsed) continue;
      const ref: ArmAccountRef = { id: a.id, name: parsed.name, subscriptionId: parsed.subscriptionId, resourceGroup: parsed.resourceGroup, endpoint: endpointHost };
      const map = readRefCache();
      map[endpointHost.toLowerCase()] = ref;
      writeRefCache(map);
      return ref;
    }
  }
  return { error: `no Cognitive Services account matching ${endpointHost} is visible to this az login — az login with the right account, or create the deployment in the portal` };
}

// ── deployments through ARM ───────────────────────────────────────────────────

/** Default capacity units per sku (Standard units are thousands of TPM).
 *  Deliberately modest — a quota error from Azure names the real ceiling. */
const DEFAULT_CAPACITY: Record<string, number> = { Standard: 10, GlobalStandard: 50, ProvisionedManaged: 1 };

function deployBody(modelId: string, capacityType: string, version?: string): string {
  return JSON.stringify({
    sku: { name: capacityType, capacity: DEFAULT_CAPACITY[capacityType] ?? 10 },
    properties: { model: { format: "OpenAI", name: modelId, ...(version ? { version } : {}) } },
  });
}

async function armModelVersion(token: string, ref: ArmAccountRef, modelId: string, fetchImpl: typeof fetch): Promise<string | undefined> {
  const j = await armGet(token, `${ref.id}/models?api-version=${ARM_API}`, fetchImpl);
  const match = (j?.value ?? []).find((m: any) => (m?.model?.name ?? m?.name) === modelId);
  return match?.model?.version ?? match?.version ?? undefined;
}

export async function armCreateDeployment(
  endpointHost: string,
  deploymentName: string,
  modelId: string,
  capacityType: string,
  fetchImpl: typeof fetch = fetch,
  execImpl: typeof spawnSyncProc = spawnSyncProc,
): Promise<ArmResult> {
  const ref = await findAccountForHost(endpointHost, fetchImpl, execImpl);
  if ("error" in ref) return { ok: false, note: ref.error };
  const t = armToken(execImpl);
  if ("error" in t) return { ok: false, note: t.error };
  const url = `${ARM}${ref.id}/deployments/${encodeURIComponent(deploymentName)}?api-version=${ARM_API}`;
  const headers = { Authorization: `Bearer ${t.token}`, "Content-Type": "application/json" };

  let r = await fetchImpl(url, { method: "PUT", headers, body: deployBody(modelId, capacityType) });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    // Some models demand an explicit version — look it up and retry once.
    if (/version/i.test(text) && r.status === 400) {
      const version = await armModelVersion(t.token, ref, modelId, fetchImpl);
      if (version) {
        r = await fetchImpl(url, { method: "PUT", headers, body: deployBody(modelId, capacityType, version) });
        if (r.ok) return { ok: true };
      }
    }
    if (r.status === 403) {
      return { ok: false, note: `your az login lacks deployment rights on ${ref.name} — you need Cognitive Services Contributor (or ask the owner): ${firstErrorLine(text)}` };
    }
    if (!r.ok) return { ok: false, note: `ARM deploy failed (HTTP ${r.status}): ${firstErrorLine(text)}` };
  }
  return { ok: true };
}

export async function armDeleteDeployment(
  endpointHost: string,
  deploymentName: string,
  fetchImpl: typeof fetch = fetch,
  execImpl: typeof spawnSyncProc = spawnSyncProc,
): Promise<ArmResult> {
  const ref = await findAccountForHost(endpointHost, fetchImpl, execImpl);
  if ("error" in ref) return { ok: false, note: ref.error };
  const t = armToken(execImpl);
  if ("error" in t) return { ok: false, note: t.error };
  const r = await fetchImpl(`${ARM}${ref.id}/deployments/${encodeURIComponent(deploymentName)}?api-version=${ARM_API}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${t.token}` },
  });
  if (r.ok || r.status === 204 || r.status === 404) return { ok: true }; // 404 via ARM = genuinely gone
  const text = await r.text().catch(() => "");
  if (r.status === 403) return { ok: false, note: `your az login lacks deployment rights on ${ref.name}: ${firstErrorLine(text)}` };
  return { ok: false, note: `ARM delete failed (HTTP ${r.status}): ${firstErrorLine(text)}` };
}

function firstErrorLine(text: string): string {
  try {
    const j = JSON.parse(text);
    const m = j?.error?.message ?? j?.message;
    if (typeof m === "string" && m) return m.slice(0, 220);
  } catch { /* not json */ }
  return text.replace(/\s+/g, " ").slice(0, 220);
}
