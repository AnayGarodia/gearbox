// Onboarding actions: add an API-key account (guided or paste-detected) and
// live-test a credential so a bad key fails on add, not at first prompt. Shared
// by the in-app `/accounts add` command and the `gearbox auth` CLI subcommand.
import { putAccount, setSecret } from "./store.ts";
import { catalogProvider, detectProviderByKey, CATALOG } from "./catalog.ts";
import { resolveCreds } from "./resolve.ts";
import type { Account } from "./types.ts";

export interface AddResult {
  ok: boolean;
  account?: Account;
  message: string;
}

/** Store an API-key (or openai-compat) account for `provider`. */
export async function addApiKeyAccount(provider: string, key: string, opts: { id?: string; label?: string } = {}): Promise<AddResult> {
  const cat = catalogProvider(provider);
  if (!cat) return { ok: false, message: `unknown provider "${provider}" — see /accounts catalog` };
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

/** Register a CLI-backed subscription account (claude-cli / codex-cli). No secret
 *  is stored — the token lives in the vendor binary, which we drive as a
 *  subprocess (ToS-clean). Requires the binary on PATH + the user logged in. */
export function addCliAccount(provider: string): AddResult {
  const cat = catalogProvider(provider);
  if (!cat || cat.group !== "cli" || !cat.binary) return { ok: false, message: `"${provider}" is not a CLI subscription provider` };
  if (!Bun.which(cat.binary)) return { ok: false, message: `the ${cat.binary} binary isn't on your PATH — install it and run \`${cat.binary} ${cat.binary === "codex" ? "login" : "/login"}\` first` };
  const account: Account = {
    id: provider,
    label: cat.label,
    provider,
    exec: "cli",
    auth: { kind: "cli", binary: cat.binary },
    models: cat.defaultModels,
    enabled: true,
    addedAt: Date.now(),
  };
  putAccount(account);
  return { ok: true, account, message: `${cat.label} ready — runs via the ${cat.binary} CLI (its own login/permissions; no token stored)` };
}

// Check whether the vendor CLI is signed in — fast, free, no model call.
// claude: `claude auth status` (JSON). codex: `codex login status` (text).
export async function cliAuthStatus(binary: string): Promise<{ loggedIn: boolean; detail?: string }> {
  try {
    if (binary === "codex") {
      const p = Bun.spawn(["codex", "login", "status"], { stdout: "pipe", stderr: "pipe" });
      const out = (await new Response(p.stdout).text()).trim();
      await p.exited;
      const loggedIn = /logged in|signed in|account:|email/i.test(out) && !/not logged in/i.test(out);
      return { loggedIn, detail: out.split("\n")[0]?.slice(0, 60) };
    }
    const p = Bun.spawn(["claude", "auth", "status"], { stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(p.stdout).text()).trim();
    await p.exited;
    try {
      const j = JSON.parse(out);
      const plan = j.subscriptionType ? `Claude ${String(j.subscriptionType).replace(/^\w/, (c: string) => c.toUpperCase())}` : "Claude";
      return { loggedIn: !!j.loggedIn, detail: j.loggedIn ? `${j.email ?? "signed in"} · ${plan}` : undefined };
    } catch {
      return { loggedIn: /logged ?in/i.test(out) && !/not/i.test(out) };
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
  if (!creds.apiKey && a.auth.kind !== "cli") return { ok: false, message: "no key stored" };
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
