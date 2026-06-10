// Azure ARM control plane — the path that ACTUALLY creates deployments.
// Data-plane API keys can list deployments, but creating/deleting them is a
// management operation (Microsoft.CognitiveServices/accounts/deployments on
// management.azure.com) that requires an Azure AD token — it's what the portal
// itself calls. The token comes from a LADDER (armAccessToken), so gearbox
// works whether or not az is installed:
//   1. a refresh token from gearbox's own device-code sign-in
//      (/account login <azure account> — works with ZERO az), kept in the
//      secret store and rotated on every use;
//   2. the user's az CLI session;
//   3. service-principal env vars (AZURE_TENANT_ID/CLIENT_ID/CLIENT_SECRET —
//      the CI shape).
// Every failure names its fix; nothing here throws.
import { spawnSyncProc, which } from "../proc.ts";
import { setSecret, getSecret, deleteSecret } from "./store.ts";
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const ARM = "https://management.azure.com";
const ARM_API = "2024-10-01"; // Microsoft.CognitiveServices GA surface

// Azure CLI's public client id — the standard first-party PUBLIC client that
// device-code sign-ins from terminals use (no secret involved; the user
// authenticates in their browser). GEARBOX_AZURE_CLIENT_ID overrides it for
// orgs that require their own app registration.
const PUBLIC_CLIENT_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46";
const clientId = () => process.env.GEARBOX_AZURE_CLIENT_ID || PUBLIC_CLIENT_ID;
const tenant = () => process.env.AZURE_TENANT_ID || "organizations";
const authBase = () => `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0`;
const SCOPE = "https://management.azure.com/.default offline_access";
const REFRESH_REF = "azure-arm:refresh-token"; // secret-store key for the device-flow refresh token

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

// ── the token ladder ──────────────────────────────────────────────────────────

let tokenCache: { token: string; expiresAt: number } | null = null;

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const FORM_HEADERS = { "Content-Type": "application/x-www-form-urlencoded" };

function cacheToken(token: string, expiresInSec: number): { token: string } {
  tokenCache = { token, expiresAt: Date.now() + expiresInSec * 1000 };
  return { token };
}

// Rung 1: gearbox's own sign-in. Exchange the stored refresh token; Azure
// rotates refresh tokens, so store the new one back. invalid_grant means the
// sign-in was revoked/expired — drop it so the ladder moves on cleanly.
async function tokenFromStoredRefresh(fetchImpl: typeof fetch): Promise<{ token: string } | null> {
  const refresh = await getSecret(REFRESH_REF).catch(() => null);
  if (!refresh) return null;
  try {
    const r = await fetchImpl(`${authBase()}/token`, {
      method: "POST",
      headers: FORM_HEADERS,
      body: form({ grant_type: "refresh_token", client_id: clientId(), scope: SCOPE, refresh_token: refresh }),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) {
      if (j?.error === "invalid_grant") await deleteSecret(REFRESH_REF).catch(() => {});
      return null;
    }
    if (j.refresh_token) await setSecret(REFRESH_REF, j.refresh_token).catch(() => {});
    return cacheToken(j.access_token, Number(j.expires_in) || 3600);
  } catch {
    return null;
  }
}

// Rung 2: the user's az CLI session (kept as its own export — doctor and
// older call sites use it directly).
export function armToken(execImpl: typeof spawnSyncProc = spawnSyncProc): { token: string } | { error: string } {
  if (process.env.GEARBOX_DISABLE_AZ === "1") {
    return { error: "ARM management is disabled (GEARBOX_DISABLE_AZ=1) — create the deployment in the portal" };
  }
  if (tokenCache && Date.now() < tokenCache.expiresAt - 5 * 60_000) return { token: tokenCache.token };
  if (!which("az")) {
    return { error: "the Azure CLI isn't installed" };
  }
  const r = execImpl(["az", "account", "get-access-token", "--resource", ARM, "--output", "json"], { stdout: "pipe", stderr: "pipe" });
  if ((r.exitCode ?? 1) !== 0) {
    const err = r.stderr.toString().trim().split("\n")[0] ?? "";
    return { error: `az couldn't issue a management token${err ? ` (${err.slice(0, 120)})` : ""}` };
  }
  try {
    const j = JSON.parse(r.stdout.toString());
    const token = String(j.accessToken ?? "");
    if (!token) return { error: "az returned no token" };
    const expiresAt = j.expires_on ? Number(j.expires_on) * 1000 : Date.parse(j.expiresOn ?? "") || Date.now() + 30 * 60_000;
    tokenCache = { token, expiresAt };
    return { token };
  } catch {
    return { error: "couldn't parse az's token output" };
  }
}

// Rung 3: service-principal env vars — the CI/headless shape.
async function tokenFromServicePrincipal(fetchImpl: typeof fetch): Promise<{ token: string } | null> {
  const { AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET } = process.env;
  if (!AZURE_TENANT_ID || !AZURE_CLIENT_ID || !AZURE_CLIENT_SECRET) return null;
  try {
    const r = await fetchImpl(`https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token`, {
      method: "POST",
      headers: FORM_HEADERS,
      body: form({ grant_type: "client_credentials", client_id: AZURE_CLIENT_ID, client_secret: AZURE_CLIENT_SECRET, scope: "https://management.azure.com/.default" }),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) return null;
    return cacheToken(j.access_token, Number(j.expires_in) || 3600);
  } catch {
    return null;
  }
}

/** The management token, from whichever rung works. The error names ALL the
 *  ways to fix it — a user with no az is told about gearbox's own sign-in
 *  first, because that one needs nothing installed. */
export async function armAccessToken(fetchImpl: typeof fetch = fetch, execImpl: typeof spawnSyncProc = spawnSyncProc): Promise<{ token: string } | { error: string }> {
  if (process.env.GEARBOX_DISABLE_AZ === "1") {
    return { error: "ARM management is disabled (GEARBOX_DISABLE_AZ=1) — create the deployment in the portal" };
  }
  if (tokenCache && Date.now() < tokenCache.expiresAt - 5 * 60_000) return { token: tokenCache.token };
  const stored = await tokenFromStoredRefresh(fetchImpl);
  if (stored) return stored;
  const az = armToken(execImpl);
  if ("token" in az) return az;
  const sp = await tokenFromServicePrincipal(fetchImpl);
  if (sp) return sp;
  return {
    error:
      "no Azure management sign-in — run /account login <your azure account> (browser device sign-in, nothing to install)" +
      `; or az login (Azure CLI${az.error.includes("isn't installed") ? " — not installed" : ""})` +
      "; or set AZURE_TENANT_ID + AZURE_CLIENT_ID + AZURE_CLIENT_SECRET",
  };
}

/** Gearbox's own Azure sign-in: the OAuth device-code flow. Shows the user a
 *  short code + URL via onCode, polls until they approve in the browser, then
 *  keeps the refresh token in the secret store — deploys work from then on
 *  with no Azure CLI anywhere. Resolves when approved, denied, or expired. */
export async function armDeviceLogin(
  onCode: (info: { userCode: string; url: string; expiresInMin: number }) => void,
  fetchImpl: typeof fetch = fetch,
  sleepImpl: (ms: number) => Promise<void> = (ms) => new Promise((res) => setTimeout(res, ms)),
): Promise<ArmResult> {
  try {
    const start = await fetchImpl(`${authBase()}/devicecode`, {
      method: "POST",
      headers: FORM_HEADERS,
      body: form({ client_id: clientId(), scope: SCOPE }),
    });
    const dc: any = await start.json().catch(() => ({}));
    if (!start.ok || !dc.device_code) {
      return { ok: false, note: `couldn't start the Azure sign-in: ${dc?.error_description?.split("\n")[0] ?? `HTTP ${start.status}`}` };
    }
    onCode({
      userCode: String(dc.user_code),
      url: String(dc.verification_uri || "https://microsoft.com/devicelogin"),
      expiresInMin: Math.round((Number(dc.expires_in) || 900) / 60),
    });
    let intervalMs = (Number(dc.interval) || 5) * 1000;
    const deadline = Date.now() + (Number(dc.expires_in) || 900) * 1000;
    while (Date.now() < deadline) {
      await sleepImpl(intervalMs);
      const r = await fetchImpl(`${authBase()}/token`, {
        method: "POST",
        headers: FORM_HEADERS,
        body: form({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: clientId(), device_code: dc.device_code }),
      });
      const j: any = await r.json().catch(() => ({}));
      if (r.ok && j.access_token) {
        if (j.refresh_token) await setSecret(REFRESH_REF, j.refresh_token).catch(() => {});
        cacheToken(j.access_token, Number(j.expires_in) || 3600);
        return { ok: true };
      }
      if (j?.error === "authorization_pending") continue;
      if (j?.error === "slow_down") { intervalMs += 5000; continue; }
      return { ok: false, note: `Azure sign-in ${j?.error === "expired_token" ? "code expired — run it again" : `failed: ${j?.error_description?.split("\n")[0] ?? j?.error ?? "unknown error"}`}` };
    }
    return { ok: false, note: "Azure sign-in code expired — run it again" };
  } catch (e: any) {
    return { ok: false, note: `Azure sign-in failed: ${e?.message ?? e}` };
  }
}

/** True when gearbox holds its own Azure sign-in (device-flow refresh token). */
export async function hasArmLogin(): Promise<boolean> {
  return (await getSecret(REFRESH_REF).catch(() => null)) != null;
}

/** Forget gearbox's own Azure sign-in. */
export async function armLogout(): Promise<void> {
  await deleteSecret(REFRESH_REF).catch(() => {});
  tokenCache = null;
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
  const t = await armAccessToken(fetchImpl, execImpl);
  if ("error" in t) return t;
  const subs = await armGet(t.token, `/subscriptions?api-version=2022-12-01`, fetchImpl);
  const subIds: string[] = (subs?.value ?? []).map((s: any) => s.subscriptionId).filter(Boolean);
  if (!subIds.length) return { error: "this Azure sign-in sees no subscriptions — sign in with the account that owns the resource (/account login <name>, or az login)" };
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
  return { error: `no Cognitive Services account matching ${endpointHost} is visible to this Azure sign-in — sign in with the right account (/account login <name>, or az login), or create the deployment in the portal` };
}

// ── deployments through ARM ───────────────────────────────────────────────────

/** Default capacity units per sku (Standard units are thousands of TPM).
 *  Deliberately modest — a quota error from Azure names the real ceiling. */
const DEFAULT_CAPACITY: Record<string, number> = { Standard: 10, GlobalStandard: 50, ProvisionedManaged: 1 };

function deployBody(modelId: string, capacityType: string, version?: string, capacity?: number): string {
  return JSON.stringify({
    sku: { name: capacityType, capacity: capacity ?? DEFAULT_CAPACITY[capacityType] ?? 10 },
    properties: { model: { format: "OpenAI", name: modelId, ...(version ? { version } : {}) } },
  });
}

async function armModelVersion(token: string, ref: ArmAccountRef, modelId: string, fetchImpl: typeof fetch): Promise<string | undefined> {
  const j = await armGet(token, `${ref.id}/models?api-version=${ARM_API}`, fetchImpl);
  const match = (j?.value ?? []).find((m: any) => (m?.model?.name ?? m?.name) === modelId);
  return match?.model?.version ?? match?.version ?? undefined;
}

/** Pull "available capacity N" out of Azure's quota-exceeded 400. Azure spells
 *  out the arithmetic ("requires 50 … available capacity 2 … usage 0, limit
 *  2"); the available number is exactly what a retry should request. */
export function availableCapacityIn(text: string): number | null {
  const m =
    text.match(/available capacity (?:is )?(\d+)/i) ??
    (() => {
      // Fallback: derive limit − usage when "available" isn't spelled out.
      const limit = text.match(/quota limit is (\d+)/i);
      const usage = text.match(/quota usage is (\d+)/i);
      return limit && usage ? ([, String(Math.max(0, Number(limit[1]) - Number(usage[1])))] as unknown as RegExpMatchArray) : null;
    })();
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

const isQuotaError = (text: string) => /quota|capacity/i.test(text);

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
  const t = await armAccessToken(fetchImpl, execImpl);
  if ("error" in t) return { ok: false, note: t.error };
  const url = `${ARM}${ref.id}/deployments/${encodeURIComponent(deploymentName)}?api-version=${ARM_API}`;
  const headers = { Authorization: `Bearer ${t.token}`, "Content-Type": "application/json" };

  let version: string | undefined;
  let capacity: number | undefined; // default per sku until the quota error teaches us better
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetchImpl(url, { method: "PUT", headers, body: deployBody(modelId, capacityType, version, capacity) });
    if (r.ok) return { ok: true, note: capacity != null ? `deployed at capacity ${capacity} (all this subscription's quota allows — request more in the portal to scale up)` : undefined };
    const text = await r.text().catch(() => "");
    // Some models demand an explicit version — look it up and go around.
    if (r.status === 400 && /version/i.test(text) && !version) {
      version = await armModelVersion(t.token, ref, modelId, fetchImpl);
      if (version) continue;
    }
    // Quota 400: Azure names the capacity actually available. Asking for the
    // sku default (e.g. 50) when the subscription's limit is 2 should deploy
    // at 2, not fail — the user can raise quota later to scale up.
    if (r.status === 400 && isQuotaError(text) && capacity == null) {
      const avail = availableCapacityIn(text);
      if (avail != null && avail >= 1) {
        capacity = avail;
        continue;
      }
      if (avail === 0) {
        return { ok: false, note: `no quota left for this model on the subscription — ${firstErrorLine(text)}\n  request a quota increase: https://ai.azure.com → Management center → Quota` };
      }
    }
    if (r.status === 403) {
      return { ok: false, note: `your Azure sign-in lacks deployment rights on ${ref.name} — you need Cognitive Services Contributor (or ask the owner): ${firstErrorLine(text)}` };
    }
    return { ok: false, note: `ARM deploy failed (HTTP ${r.status}): ${firstErrorLine(text)}` };
  }
  return { ok: false, note: "ARM deploy failed after retries" };
}

export async function armDeleteDeployment(
  endpointHost: string,
  deploymentName: string,
  fetchImpl: typeof fetch = fetch,
  execImpl: typeof spawnSyncProc = spawnSyncProc,
): Promise<ArmResult> {
  const ref = await findAccountForHost(endpointHost, fetchImpl, execImpl);
  if ("error" in ref) return { ok: false, note: ref.error };
  const t = await armAccessToken(fetchImpl, execImpl);
  if ("error" in t) return { ok: false, note: t.error };
  const r = await fetchImpl(`${ARM}${ref.id}/deployments/${encodeURIComponent(deploymentName)}?api-version=${ARM_API}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${t.token}` },
  });
  if (r.ok || r.status === 204 || r.status === 404) return { ok: true }; // 404 via ARM = genuinely gone
  const text = await r.text().catch(() => "");
  if (r.status === 403) return { ok: false, note: `your Azure sign-in lacks deployment rights on ${ref.name}: ${firstErrorLine(text)}` };
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
