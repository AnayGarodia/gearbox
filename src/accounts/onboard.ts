// Onboarding actions: add an API-key account (guided or paste-detected) and
// live-test a credential so a bad key fails on add, not at first prompt. Shared
// by the in-app `/accounts add` command and the `gearbox auth` CLI subcommand.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { putAccount, setSecret } from "./store.ts";
import { catalogProvider, CATALOG } from "./catalog.ts";
import { normalizeProviderId } from "./onboarding.ts";
import { sniffCredential, type CredentialGuess } from "./sniff.ts";
import { resolveCreds } from "./resolve.ts";
import { HEALTH_CHECK_TIMEOUT_MS } from "./health.ts";
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
  // A full URL whose host is NOT *.openai.azure.com is a Foundry/AI-services
  // endpoint (services.ai.azure.com, cognitiveservices.azure.com, custom
  // domains). Minting a classic account from it builds a broken
  // https://<sub>.openai.azure.com base for every call — route it to the
  // Foundry/openai-compat path, which carries the real baseUrl.
  const url = /^https?:\/\//i.test(resourceOrEndpoint.trim()) ? (() => { try { return new URL(resourceOrEndpoint.trim()); } catch { return null; } })() : null;
  if (url && !/\.openai\.azure\.com$/i.test(url.hostname)) {
    return addAzureFoundryAccount(resourceOrEndpoint.trim(), key, { id: opts.id, label: opts.label });
  }
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

/** Store an Amazon Bedrock (AWS IAM) account. Secrets are stored by ref; the
 *  account carries the region. Live connectivity is verified on first use. */
export async function addBedrockAccount(accessKeyId: string, secretAccessKey: string, region: string, opts: { id?: string; label?: string } = {}): Promise<AddResult> {
  if (!accessKeyId.trim() || !secretAccessKey.trim() || !region.trim()) {
    return { ok: false, message: "usage: /account add bedrock <access-key-id> <secret-access-key> <region>" };
  }
  const id = opts.id ?? `bedrock-${shortId()}`;
  const accessKeyIdRef = `${id}:aws-access-key-id`;
  const secretKeyRef = `${id}:aws-secret-access-key`;
  await setSecret(accessKeyIdRef, accessKeyId.trim());
  await setSecret(secretKeyRef, secretAccessKey.trim());
  const account: Account = {
    id,
    label: opts.label ?? `Amazon Bedrock (${region})`,
    provider: "bedrock",
    exec: "in-loop",
    auth: { kind: "aws", accessKeyIdRef, secretKeyRef, region: region.trim() },
    enabled: true,
    addedAt: Date.now(),
  };
  putAccount(account);
  return { ok: true, account, message: `added ${account.label} (${id})` };
}

/** Store a Google Vertex AI account. Auth is gcloud ADC (application-default
 *  login) by default, or a pasted service-account JSON stored by ref. Live
 *  connectivity is verified on first use (see testAccount). */
export async function addVertexAccount(project: string, location: string, serviceAccountJson?: string, opts: { id?: string; label?: string } = {}): Promise<AddResult> {
  if (!project.trim() || !location.trim()) {
    return { ok: false, message: "usage: /account add vertex <project> <location> [service-account-json]" };
  }
  const sa = serviceAccountJson?.trim();
  if (sa) {
    try {
      const j = JSON.parse(sa);
      if (j?.type !== "service_account") return { ok: false, message: 'vertex: that JSON is not a service-account key (expected "type": "service_account")' };
    } catch {
      return { ok: false, message: "vertex: the service-account JSON didn't parse" };
    }
  }
  const id = opts.id ?? `vertex-${slugify(project)}`;
  if (sa) await setSecret(`${id}:service-account`, sa);
  const account: Account = {
    id,
    label: opts.label ?? `Vertex AI (${project.trim()})`,
    provider: "vertex",
    exec: "in-loop",
    auth: sa
      ? { kind: "vertex", project: project.trim(), location: location.trim(), serviceAccountRef: `${id}:service-account` }
      : { kind: "vertex", project: project.trim(), location: location.trim(), adc: true },
    enabled: true,
    addedAt: Date.now(),
  };
  putAccount(account);
  return { ok: true, account, message: `added ${account.label}${sa ? " (service account)" : " (ADC)"}` };
}

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
  // Strip the API key so we probe the SUBSCRIPTION login, not an env key that would
  // otherwise shadow it (see cli-backend.subscriptionEnv). `profile` scopes the
  // check to a specific account's config dir for multi-account setups.
  const env = subscriptionEnv(binary, profile);
  // codex prints its auth status to stderr; claude prints to stdout — read both.
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
    // Match the first JSON object containing "loggedIn" (robust to surrounding CLI noise).
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

/** Paste any credential — identify it via the sniffer, then add it (or return a
 *  precise guided message naming exactly what else is needed). */
export async function addByPastedKey(key: string): Promise<AddResult> {
  const g = sniffCredential(key);
  if ((g.kind === "api-key" || g.kind === "openai-compat") && g.provider) {
    return addApiKeyAccount(g.provider, g.fields.apiKey ?? key);
  }
  if (g.kind === "aws" && !g.missing.length) {
    return addBedrockAccount(g.fields.accessKeyId!, g.fields.secretAccessKey!, g.fields.region!);
  }
  return { ok: false, message: guidedMessageFor(g) };
}

function guidedMessageFor(g: CredentialGuess): string {
  if (g.kind === "aws") return `looks like AWS/Bedrock — provide all three: /account add bedrock <access-key-id> <secret> <region>`;
  if (g.kind === "azure") return `looks like Azure (${g.fields.resourceName ?? "resource"}) — add the key: /account add azure ${g.fields.endpoint ?? "<endpoint>"} <api-key>`;
  if (g.kind === "vertex") return `looks like a Vertex service-account key. Paste it via the wizard: /account → "+ Add an account" → Google Vertex AI, or use gcloud ADC: /account add vertex ${g.fields.project || "<project>"} <location>`;
  return `couldn't identify that credential — use /account add <provider> <key>, or /onboard for options`;
}

/** A cheap live check that a stored account's credential actually works. */
export async function testAccount(a: Account): Promise<{ ok: boolean; message: string }> {
  const creds = await resolveCreds(a);
  // Cloud providers use non-apiKey auth — don't gate on apiKey presence.
  const isCloud = a.auth.kind === "aws" || a.auth.kind === "azure" || a.auth.kind === "vertex";
  if (!creds.apiKey && !isCloud && a.auth.kind !== "cli") return { ok: false, message: "no key stored" };
  // Every probe is timeout-bounded — testAccount is called from the UI thread
  // (App.tsx / cli.tsx) and a hung endpoint must never block it forever.
  const signal = () => AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS);
  try {
    if (a.provider === "anthropic") {
      const r = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
        method: "POST",
        headers: { "x-api-key": creds.apiKey ?? "", "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku-4-5", messages: [{ role: "user", content: "hi" }] }),
        signal: signal(),
      });
      return r.ok ? { ok: true, message: "credential works" } : { ok: false, message: await errMessage(r) };
    }
    if (a.provider === "google") {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${creds.apiKey ?? ""}`, { signal: signal() });
      return r.ok ? { ok: true, message: "credential works" } : { ok: false, message: await errMessage(r) };
    }
    // Azure OpenAI: list deployments using the resource endpoint + api-key header.
    if (a.provider === "azure" && creds.azure) {
      const { resourceName, apiKey, apiVersion = "2024-08-01-preview" } = creds.azure;
      if (!resourceName || !apiKey) return { ok: false, message: "azure: resourceName and apiKey are required" };
      const r = await fetch(
        `https://${resourceName}.openai.azure.com/openai/models?api-version=${apiVersion}`,
        { headers: { "api-key": apiKey }, signal: signal() },
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
      return { ok: true, message: `credential fields present — Bedrock at ${bedrockListUrl(creds.aws.region)} (connectivity verified on first use)` };
    }
    // Vertex: validate project and location are set.
    if (a.provider === "vertex" && creds.vertex) {
      const { project, location } = creds.vertex;
      if (!project) return { ok: false, message: "vertex: GOOGLE_VERTEX_PROJECT is required" };
      if (!location) return { ok: false, message: "vertex: GOOGLE_VERTEX_LOCATION is required" };
      return { ok: true, message: "credential fields present (Vertex connectivity verified on first use — run `gcloud auth application-default login` if not done)" };
    }
    // openai-compat / openai / gateways / local: list models on the endpoint.
    // Providers WITHOUT a /models route (Perplexity) get a minimal 1-token chat
    // probe instead — a valid pplx- key used to fail with a bare "HTTP 404".
    const base = creds.baseURL ?? "https://api.openai.com/v1";
    const cat = catalogProvider(a.provider);
    if (cat?.noModelsEndpoint) {
      const probeModel = a.models?.[0] ?? cat.defaultModels?.[0];
      const pr = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${creds.apiKey ?? ""}`, "Content-Type": "application/json", ...(creds.headers ?? {}) },
        body: JSON.stringify({ model: probeModel, messages: [{ role: "user", content: "ok" }], max_tokens: 1 }),
        signal: signal(),
      });
      return pr.ok ? { ok: true, message: "credential works" } : { ok: false, message: `${await errMessage(pr)} from ${base}/chat/completions` };
    }
    const r = await fetch(`${base.replace(/\/$/, "")}/models`, {
      headers: { Authorization: `Bearer ${creds.apiKey ?? ""}`, ...(creds.headers ?? {}) },
      signal: signal(),
    });
    return r.ok ? { ok: true, message: "credential works" } : { ok: false, message: `${await errMessage(r)} from ${base}/models` };
  } catch (e: any) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError")
      return { ok: false, message: `request timed out after ${HEALTH_CHECK_TIMEOUT_MS / 1000}s` };
    return { ok: false, message: e?.message ?? "request failed" };
  }
}

/** The regional Bedrock control-plane endpoint for listing foundation models.
 *  A live check needs SigV4 signing (not wired yet), so testAccount validates
 *  the credential fields and verifies real connectivity on first use. */
export function bedrockListUrl(region: string): string {
  return `https://bedrock.${region}.amazonaws.com/foundation-models`;
}

/** Providers that can be added with a plain API key (for `/accounts catalog`). */
export function addableProviders(): { id: string; label: string; group: string }[] {
  return CATALOG.filter((p) => p.authKind === "api-key" || p.authKind === "openai-compat").map((p) => ({ id: p.id, label: p.label, group: p.group }));
}

// Extract the provider's own error message from a failed response body (e.g. "invalid api key").
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

// Short unique suffix: collision-resistant at runtime but not used in scripts or tests.
function shortId(): string {
  return Date.now().toString(36).slice(-4) + Math.floor(Math.random() * 1296).toString(36).padStart(2, "0");
}
