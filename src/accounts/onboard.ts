// Onboarding actions: add an API-key account (guided or paste-detected) and
// live-test a credential so a bad key fails on add, not at first prompt. Shared
// by the in-app `/accounts add` command and the `gearbox auth` CLI subcommand.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { putAccount, setSecret } from "./store.ts";
import { catalogProvider, detectProviderByKey, CATALOG } from "./catalog.ts";
import { normalizeProviderId } from "./onboarding.ts";
import { resolveCreds } from "./resolve.ts";
import { subscriptionEnv } from "../agent/cli-backend.ts";
import { which, spawnProc, readStream } from "../proc.ts";
import type { Account } from "./types.ts";

export interface AddResult {
  ok: boolean;
  account?: Account;
  message: string;
}

export interface CliAuthStatus {
  loggedIn: boolean;
  detail?: string;
  identity?: string;
  identityLabel?: string;
}

function slugify(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || shortId();
}

/** Store an API-key (or openai-compat) account for `provider`. */
export async function addApiKeyAccount(provider: string, key: string, opts: { id?: string; label?: string } = {}): Promise<AddResult> {
  provider = normalizeProviderId(provider);
  const cat = catalogProvider(provider);
  if (!cat) return { ok: false, message: `unknown provider "${provider}" — use /onboard providers` };
  if (cat.group === "cli") return { ok: false, message: `${cat.label} is a subscription account — use /login ${provider} (P3), not a key` };
  if (cat.authKind !== "api-key" && cat.authKind !== "openai-compat") {
    return { ok: false, message: `${cat.label} needs ${cat.authKind} credentials — use the guided add (P2)` };
  }
  const id = opts.id ?? `${provider}-${shortId()}`;
  const ref = `${id}:api-key`;
  await setSecret(ref, key.trim());
  const account: Account = {
    id,
    label: opts.label ?? cat.label,
    provider,
    exec: "in-loop",
    auth: cat.authKind === "openai-compat" ? { kind: "openai-compat", ref } : { kind: "api-key", ref },
    baseUrl: cat.baseUrl,
    enabled: true,
    addedAt: Date.now(),
  };
  putAccount(account);
  return { ok: true, account, message: `added ${account.label} (${id})` };
}

/** Store any OpenAI-compatible API endpoint. This is the generic escape hatch
 * for LiteLLM, self-hosted gateways, enterprise proxies, and new providers. */
export async function addOpenAICompatAccount(name: string, baseUrl: string, key: string, models: string[], opts: { id?: string; label?: string } = {}): Promise<AddResult> {
  if (!/^https?:\/\//i.test(baseUrl) || !models.length) {
    return { ok: false, message: "usage: /account add openai-compat <name> <base-url> <api-key> <model> [model...]" };
  }
  const known = catalogProvider(normalizeProviderId(name));
  const provider = known?.authKind === "openai-compat" ? known.id : `custom-${slugify(name)}`;
  const id = opts.id ?? `${provider}-${shortId()}`;
  const ref = `${id}:api-key`;
  await setSecret(ref, key.trim());
  const account: Account = {
    id,
    label: opts.label ?? (known?.label ?? (name.trim() || "OpenAI-compatible")),
    provider,
    exec: "in-loop",
    auth: { kind: "openai-compat", ref },
    baseUrl: baseUrl.replace(/\/+$/, ""),
    models,
    enabled: true,
    addedAt: Date.now(),
  };
  putAccount(account);
  return { ok: true, account, message: `added ${account.label} (${models.length} model${models.length === 1 ? "" : "s"})` };
}

function azureResourceName(input: string): string {
  const s = input.trim();
  try {
    const host = new URL(s).hostname;
    return host.split(".")[0] || s;
  } catch {
    return s;
  }
}

function azureFoundryBaseUrl(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  if (/\/openai\/v1$/i.test(trimmed)) return trimmed;
  if (/\/openai$/i.test(trimmed)) return `${trimmed}/v1`;
  return `${trimmed}/openai/v1`;
}

/** Store an Azure AI Foundry OpenAI-compatible endpoint account. */
export async function addAzureFoundryAccount(endpoint: string, key: string, opts: { id?: string; label?: string } = {}): Promise<AddResult> {
  if (!/^https?:\/\//i.test(endpoint) || !key.trim()) return { ok: false, message: "usage: /account add azure <foundry-endpoint> <api-key>" };
  const host = new URL(endpoint).hostname;
  const slug = host.split(".")[0]?.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || shortId();
  const id = opts.id ?? `azure-foundry-${slug}`;
  const ref = `${id}:api-key`;
  await setSecret(ref, key.trim());
  const account: Account = {
    id,
    label: opts.label ?? `Azure Foundry (${slug})`,
    provider: "azure-foundry",
    exec: "in-loop",
    auth: { kind: "openai-compat", ref },
    baseUrl: azureFoundryBaseUrl(endpoint),
    enabled: true,
    addedAt: Date.now(),
  };
  putAccount(account);
  return { ok: true, account, message: `added ${account.label} (${id})` };
}

/** Store an Azure OpenAI / Azure AI Foundry resource account. */
export async function addAzureAccount(resourceOrEndpoint: string, key: string, opts: { apiVersion?: string; id?: string; label?: string } = {}): Promise<AddResult> {
  const resourceName = azureResourceName(resourceOrEndpoint);
  if (!resourceName || !key.trim()) return { ok: false, message: "usage: /account add azure <resource-or-endpoint> <api-key> [api-version]" };
  const id = opts.id ?? `azure-${slugify(resourceName)}`;
  const ref = `${id}:api-key`;
  await setSecret(ref, key.trim());
  const account: Account = {
    id,
    label: opts.label ?? `Azure (${resourceName})`,
    provider: "azure",
    exec: "in-loop",
    auth: { kind: "azure", resourceName, ref, apiVersion: opts.apiVersion },
    enabled: true,
    addedAt: Date.now(),
  };
  putAccount(account);
  return { ok: true, account, message: `added ${account.label} (${id})` };
}

/** Register a CLI-backed subscription account (claude-cli / codex-cli). No secret
 *  is stored — the token lives in the vendor binary, which we drive as a
 *  subprocess (ToS-clean). Requires the binary on PATH + the user logged in. */
// Per-account config dir for a named CLI account, so multiple claude (or codex)
// logins coexist. The unnamed account reuses the system default login.
function cliProfileDir(id: string): string {
  const home = process.env.GEARBOX_HOME || join(homedir(), ".gearbox");
  return join(home, "cli", id);
}

/**
 * Register a CLI-backed subscription account. With no `name` it's the default
 * account (id = provider, reuses the system `claude`/`codex` login). With a
 * `name` it's an additional, isolated account (its own config dir) — that's how
 * you run MULTIPLE Claude or Codex subscriptions at once.
 */
export function addCliAccount(provider: string, name?: string): AddResult {
  const cat = catalogProvider(provider);
  if (!cat || cat.group !== "cli" || !cat.binary) return { ok: false, message: `"${provider}" is not a CLI subscription provider` };
  if (!which(cat.binary)) return { ok: false, message: `the ${cat.binary} binary isn't on your PATH — install it first` };
  const slug = name ? name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") : "";
  const id = slug ? `${provider}-${slug}` : provider;
  const profile = slug ? cliProfileDir(id) : undefined; // named → isolated dir; default → system login
  if (profile) mkdirSync(profile, { recursive: true });
  const account: Account = {
    id,
    label: slug ? `${cat.label.replace(/ \(.*\)$/, "")} (${name!.trim()})` : cat.label,
    provider,
    exec: "cli",
    auth: { kind: "cli", binary: cat.binary, loginProfile: profile },
    models: cat.defaultModels,
    enabled: true,
    addedAt: Date.now(),
  };
  putAccount(account);
  return { ok: true, account, message: `${account.label} ready — runs via the ${cat.binary} CLI${profile ? " (separate login)" : ""}` };
}

// Check whether the vendor CLI is signed in — fast, free, no model call.
// claude: `claude auth status` (JSON). codex: `codex login status` (text).
export async function cliAuthStatus(binary: string, profile?: string): Promise<CliAuthStatus> {
  // Strip the API key from the env so we report the SUBSCRIPTION login, not an
  // env API key (which would otherwise shadow it — see cli-backend.subscriptionEnv).
  // `profile` scopes the check to a specific account's config dir (multi-account).
  const env = subscriptionEnv(binary, profile);
  // Read BOTH streams: codex prints its status to stderr, claude to stdout.
  const readBoth = async (cmd: string[], timeoutMs = 5_000): Promise<{ out: string; timedOut: boolean }> => {
    const p = spawnProc(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        p.kill();
      } catch {
        /* already exited */
      }
    }, timeoutMs);
    try {
      const [o, e] = await Promise.all([readStream(p.stdout), readStream(p.stderr)]);
      await p.exited.catch(() => {});
      return { out: `${o}\n${e}`.trim(), timedOut };
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    if (binary === "codex") {
      const { out, timedOut } = await readBoth(["codex", "login", "status"]);
      if (timedOut) return { loggedIn: false, detail: "`codex login status` timed out" };
      const loggedIn = /logged in|signed in|account:|email|using chatgpt/i.test(out) && !/not logged in|not signed in/i.test(out);
      const email = out.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase();
      const detail = loggedIn ? (out.split("\n").map((l) => l.trim()).find((l) => /@|plan|chatgpt/i.test(l))?.slice(0, 80) || "ChatGPT") : undefined;
      return { loggedIn, detail, identity: email ? `codex:${email}` : undefined, identityLabel: email };
    }
    const { out, timedOut } = await readBoth(["claude", "auth", "status"]);
    if (timedOut) return { loggedIn: false, detail: "`claude auth status` timed out" };
    // Extract the flat JSON object that carries loggedIn (robust to any noise).
    const m = out.match(/\{[^{}]*"loggedIn"[\s\S]*?\}/);
    try {
      const j = JSON.parse(m ? m[0] : out);
      const parts: string[] = [];
      if (j.email) parts.push(j.email);
      if (j.subscriptionType) parts.push(`Claude ${String(j.subscriptionType).replace(/^\w/, (c: string) => c.toUpperCase())}`);
      else if (j.authMethod && j.authMethod !== "claude.ai") parts.push(`auth: ${j.authMethod}`);
      const email = typeof j.email === "string" ? j.email.toLowerCase() : undefined;
      return { loggedIn: !!j.loggedIn, detail: parts.join(" · ") || undefined, identity: email ? `claude:${email}` : undefined, identityLabel: email };
    } catch {
      return { loggedIn: /"loggedIn"\s*:\s*true/.test(out) };
    }
  } catch {
    return { loggedIn: false };
  }
}

/** The argv that starts the vendor's interactive sign-in flow. */
export function cliLoginArgs(binary: string): string[] {
  return binary === "codex" ? ["login"] : ["auth", "login"];
}

/** Paste any key — detect the provider from its prefix, then add it. */
export async function addByPastedKey(key: string): Promise<AddResult> {
  const provider = detectProviderByKey(key);
  if (!provider) return { ok: false, message: "couldn't identify the provider from that key — use /accounts add <provider> <key>" };
  return addApiKeyAccount(provider, key);
}

/** A cheap live check that a stored account's credential actually works. */
export async function testAccount(a: Account): Promise<{ ok: boolean; message: string }> {
  const creds = await resolveCreds(a);
  // Cloud providers use non-apiKey auth — don't gate on apiKey presence.
  const isCloud = a.auth.kind === "aws" || a.auth.kind === "azure" || a.auth.kind === "vertex";
  if (!creds.apiKey && !isCloud && a.auth.kind !== "cli") return { ok: false, message: "no key stored" };
  try {
    if (a.provider === "anthropic") {
      const r = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
        method: "POST",
        headers: { "x-api-key": creds.apiKey ?? "", "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku-4-5", messages: [{ role: "user", content: "hi" }] }),
      });
      return r.ok ? { ok: true, message: "credential works" } : { ok: false, message: await errMessage(r) };
    }
    if (a.provider === "google") {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${creds.apiKey ?? ""}`);
      return r.ok ? { ok: true, message: "credential works" } : { ok: false, message: await errMessage(r) };
    }
    // Azure OpenAI: list deployments using the resource endpoint + api-key header.
    if (a.provider === "azure" && creds.azure) {
      const { resourceName, apiKey, apiVersion = "2024-08-01-preview" } = creds.azure;
      if (!resourceName || !apiKey) return { ok: false, message: "azure: resourceName and apiKey are required" };
      const r = await fetch(
        `https://${resourceName}.openai.azure.com/openai/models?api-version=${apiVersion}`,
        { headers: { "api-key": apiKey } },
      );
      return r.ok ? { ok: true, message: "credential works" } : { ok: false, message: await errMessage(r) };
    }
    // Bedrock: validate credential fields are present (live call requires SigV4 signing).
    if (a.provider === "bedrock" && creds.aws) {
      const { accessKeyId, secretAccessKey, region } = creds.aws;
      if (!accessKeyId || !secretAccessKey) return { ok: false, message: "bedrock: AWS access key and secret are required" };
      if (!region) return { ok: false, message: "bedrock: AWS_REGION is required" };
      const keyOk = /^(AKIA|ASIA)[A-Z0-9]{16}$/.test(accessKeyId);
      if (!keyOk) return { ok: false, message: `bedrock: access key ID looks malformed (expected AKIA… or ASIA…, got ${accessKeyId.slice(0, 8)}…)` };
      return { ok: true, message: "credential fields present (Bedrock connectivity verified on first use)" };
    }
    // Vertex: validate project and location are set.
    if (a.provider === "vertex" && creds.vertex) {
      const { project, location } = creds.vertex;
      if (!project) return { ok: false, message: "vertex: GOOGLE_VERTEX_PROJECT is required" };
      if (!location) return { ok: false, message: "vertex: GOOGLE_VERTEX_LOCATION is required" };
      return { ok: true, message: "credential fields present (Vertex connectivity verified on first use — run `gcloud auth application-default login` if not done)" };
    }
    // openai-compat / openai / gateways / local: list models on the endpoint.
    const base = creds.baseURL ?? "https://api.openai.com/v1";
    const r = await fetch(`${base.replace(/\/$/, "")}/models`, {
      headers: { Authorization: `Bearer ${creds.apiKey ?? ""}`, ...(creds.headers ?? {}) },
    });
    return r.ok ? { ok: true, message: "credential works" } : { ok: false, message: await errMessage(r) };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? "request failed" };
  }
}

/** Providers that can be added with a plain API key (for `/accounts catalog`). */
export function addableProviders(): { id: string; label: string; group: string }[] {
  return CATALOG.filter((p) => p.authKind === "api-key" || p.authKind === "openai-compat").map((p) => ({ id: p.id, label: p.label, group: p.group }));
}

// Pull the provider's own error text out of a failed response (e.g. "credit
// balance too low", "invalid api key") so the user sees the real reason.
async function errMessage(r: Response): Promise<string> {
  try {
    const j: any = await r.json();
    const m = j?.error?.message ?? j?.message ?? j?.error;
    if (typeof m === "string" && m) return `${m} (HTTP ${r.status})`;
  } catch {
    /* non-JSON body */
  }
  return `HTTP ${r.status}`;
}

// Short, dependency-free unique-ish suffix (Date.now()+random is fine at runtime;
// not used in workflow scripts).
function shortId(): string {
  return Date.now().toString(36).slice(-4) + Math.floor(Math.random() * 1296).toString(36).padStart(2, "0");
}
