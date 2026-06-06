import { test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setSecret, getSecret, deleteSecret,
  putAccount, getAccount, listAccounts, accountsForProvider,
  defaultAccount, setDefaultAccount, removeAccount, secretRefs,
} from "../src/accounts/store.ts";
import { CATALOG, catalogProvider, detectProviderByKey } from "../src/accounts/catalog.ts";
import { importEnvCred, importableEnvCreds } from "../src/accounts/detect.ts";
import { resolveCreds } from "../src/accounts/resolve.ts";
import { addApiKeyAccount, addAzureAccount, addAzureFoundryAccount, addByPastedKey, addCliAccount, addOpenAICompatAccount } from "../src/accounts/onboard.ts";
import { subscriptionEnv } from "../src/agent/cli-backend.ts";
import { detectCloudCreds, importCloudCred } from "../src/accounts/detect.ts";
import { recordUsage, recordRateLimits, loadUsage, accountUsage, totalSpent, buildUsageView } from "../src/accounts/usage.ts";
import { MODELS, findModel, modelRegistry, resolveModel } from "../src/providers.ts";
import type { Account } from "../src/accounts/types.ts";

// Force the deterministic file store (the keychain path is OS-dependent / can
// prompt) and an isolated home so the suite never touches the real ~/.gearbox.
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "gearbox-acct-"));
  process.env.GEARBOX_HOME = home;
  process.env.GEARBOX_SECRET_STORE = "file";
});
afterAll(() => {
  delete process.env.GEARBOX_HOME;
  delete process.env.GEARBOX_SECRET_STORE;
});

const mk = (over: Partial<Account> = {}): Account => ({
  id: "anthropic-work", label: "Anthropic (work)", provider: "anthropic",
  exec: "in-loop", auth: { kind: "api-key", ref: "anthropic-work:api-key" },
  enabled: true, addedAt: 1, ...over,
});

test("secret round-trips through the encrypted file store", async () => {
  await setSecret("anthropic-work:api-key", "sk-ant-secret");
  expect(await getSecret("anthropic-work:api-key")).toBe("sk-ant-secret");
  expect(await getSecret("missing")).toBeNull();
  await deleteSecret("anthropic-work:api-key");
  expect(await getSecret("anthropic-work:api-key")).toBeNull();
});

test("encrypted file does not contain the plaintext secret", async () => {
  await setSecret("k:api-key", "sk-ant-PLAINTEXT-SHOULD-NOT-APPEAR");
  const raw = (await import("node:fs")).readFileSync(join(home, "credentials.enc"), "utf8");
  expect(raw).not.toContain("PLAINTEXT-SHOULD-NOT-APPEAR");
});

test("account registry: put / get / list / per-provider / default", () => {
  putAccount(mk());
  putAccount(mk({ id: "anthropic-personal", label: "Anthropic (personal)" }));
  putAccount(mk({ id: "or-1", provider: "openrouter", label: "OpenRouter", auth: { kind: "openai-compat", ref: "or-1:api-key" }, baseUrl: "https://openrouter.ai/api/v1" }));

  expect(listAccounts()).toHaveLength(3);
  expect(accountsForProvider("anthropic")).toHaveLength(2);
  expect(getAccount("or-1")?.baseUrl).toBe("https://openrouter.ai/api/v1");
  // first account of a provider becomes its default
  expect(defaultAccount("anthropic")?.id).toBe("anthropic-work");
  setDefaultAccount("anthropic", "anthropic-personal");
  expect(defaultAccount("anthropic")?.id).toBe("anthropic-personal");
});

test("removeAccount reassigns the default and wipes its secrets", async () => {
  const a = mk();
  putAccount(a);
  putAccount(mk({ id: "anthropic-personal" }));
  await setSecret("anthropic-work:api-key", "sk-ant-x");

  await removeAccount("anthropic-work");
  expect(getAccount("anthropic-work")).toBeUndefined();
  expect(await getSecret("anthropic-work:api-key")).toBeNull(); // secret cleaned up
  expect(defaultAccount("anthropic")?.id).toBe("anthropic-personal"); // default moved
});

// ── catalog ──
test("catalog has unique ids and well-formed rows", () => {
  const ids = CATALOG.map((p) => p.id);
  expect(new Set(ids).size).toBe(ids.length); // unique
  for (const p of CATALOG) {
    expect(p.label.length).toBeGreaterThan(0);
    // openai-wire providers need an endpoint (except self-hosted ones like
    // litellm where the user supplies the baseUrl).
    if ((p.group === "openai-compat" || p.group === "local") && p.id !== "litellm") {
      expect(p.baseUrl).toBeTruthy();
    }
    if (p.group === "cli") expect(p.binary).toBeTruthy();
  }
  expect(catalogProvider("openrouter")?.baseUrl).toContain("openrouter.ai");
});

test("paste-detect picks the most specific key prefix", () => {
  expect(detectProviderByKey("sk-ant-abc123")).toBe("anthropic");
  expect(detectProviderByKey("sk-or-v1-xyz")).toBe("openrouter");
  expect(detectProviderByKey("gsk_abc")).toBe("groq");
  expect(detectProviderByKey("xai-abc")).toBe("xai");
  expect(detectProviderByKey("AKIA1234")).toBe("bedrock");
  expect(detectProviderByKey("sk-proj-abc")).toBe("openai"); // beats bare sk-
  expect(detectProviderByKey("totally-unknown")).toBeUndefined();
});

// ── detect/import (env → stored account) ──
test("importEnvCred stores a usable account and resolves its creds", async () => {
  const c = { provider: "anthropic", label: "Anthropic", envVar: "ANTHROPIC_API_KEY", value: "sk-ant-imported" };
  const acc = await importEnvCred(c);
  expect(acc.id).toBe("anthropic-env");
  expect(getAccount("anthropic-env")?.auth.kind).toBe("api-key");
  expect(await resolveCreds(acc)).toEqual({ apiKey: "sk-ant-imported" });

  // openai-compat import carries the catalog baseUrl into the resolved creds
  const g = await importEnvCred({ provider: "groq", label: "Groq", envVar: "GROQ_API_KEY", value: "gsk_x" });
  const creds = await resolveCreds(g);
  expect(creds.apiKey).toBe("gsk_x");
  expect(creds.baseURL).toContain("groq.com");
});

test("importableEnvCreds excludes already-imported providers", async () => {
  process.env.OPENAI_API_KEY = "sk-test-openai";
  try {
    expect(importableEnvCreds().some((c) => c.provider === "openai")).toBe(true);
    await importEnvCred({ provider: "openai", label: "OpenAI", envVar: "OPENAI_API_KEY", value: "sk-test-openai" });
    expect(importableEnvCreds().some((c) => c.provider === "openai")).toBe(false); // now stored
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

// ── P1: the catalog providers are now runnable models, not just stored ──
test("MODELS is generated from the catalog (the long tail is selectable)", () => {
  // curated natives still present and canonical
  expect(findModel("claude-sonnet-4-6")?.provider).toBe("anthropic");
  // generated openai-compat models exist and are namespaced
  expect(findModel("xai/grok-4.3")?.provider).toBe("xai");
  expect(findModel("groq/llama-3.3-70b-versatile")?.provider).toBe("groq");
  // no duplicate ids
  const ids = MODELS.map((m) => m.id);
  expect(new Set(ids).size).toBe(ids.length);
  // cli providers are NOT in the model registry (they run via subprocess)
  expect(MODELS.some((m) => m.provider === "claude-cli")).toBe(false);
});

test("resolveModel builds an openai-compat model via the catalog baseUrl", () => {
  const spec = findModel("groq/llama-3.3-70b-versatile")!;
  const model = resolveModel(spec, { apiKey: "gsk_test", baseURL: "https://api.groq.com/openai/v1" });
  expect(model).toBeTruthy(); // constructs without throwing (no network)
  // and without explicit creds it falls back to the catalog baseUrl path too
  expect(resolveModel(spec)).toBeTruthy();
});

test("addByPastedKey detects the provider and stores a usable account", async () => {
  const res = await addByPastedKey("sk-ant-pasted-key");
  expect(res.ok).toBe(true);
  expect(res.account?.provider).toBe("anthropic");
  expect(await resolveCreds(res.account!)).toMatchObject({ apiKey: "sk-ant-pasted-key" });

  const groq = await addApiKeyAccount("groq", "gsk_pasted");
  expect(groq.account?.auth.kind).toBe("openai-compat");
  expect((await resolveCreds(groq.account!)).baseURL).toContain("groq.com");
});

test("custom OpenAI-compatible accounts add selectable user-declared models", async () => {
  const res = await addOpenAICompatAccount("Acme Router", "https://llm.acme.test/v1", "acme-key", ["acme-coder", "acme-fast"]);
  expect(res.ok).toBe(true);
  expect(res.account?.provider).toBe("custom-acme-router");
  expect((await resolveCreds(res.account!)).baseURL).toBe("https://llm.acme.test/v1");
  expect(modelRegistry().some((m) => m.id === "custom-acme-router/acme-coder" && m.provider === "custom-acme-router")).toBe(true);
});

test("common provider aliases normalize during account add", async () => {
  const gemini = await addApiKeyAccount("gemini", "AIza-test");
  expect(gemini.ok).toBe(true);
  expect(gemini.account?.provider).toBe("google");

  const grok = await addApiKeyAccount("grok", "xai-test");
  expect(grok.ok).toBe(true);
  expect(grok.account?.provider).toBe("xai");
});

// ── P2: cloud providers ──
test("resolveModel builds Bedrock / Vertex / Azure clients without throwing", () => {
  expect(resolveModel(findModel("bedrock/anthropic.claude-sonnet-4-20250514-v1:0")!, { aws: { accessKeyId: "AKIA", secretAccessKey: "s", region: "us-east-2" } })).toBeTruthy();
  expect(resolveModel(findModel("vertex/gemini-3.1-pro-preview")!, { vertex: { project: "p", location: "us-central1" } })).toBeTruthy();
  // azure has no generated model; construct a spec
  expect(resolveModel({ id: "azure/gpt-5.4", provider: "azure", sdkId: "gpt-5.4", label: "azure-gpt", contextWindow: 128_000 }, { azure: { resourceName: "myres", apiKey: "k" } })).toBeTruthy();
});

test("cloud account stores secrets and resolveCreds returns the cloud config", async () => {
  process.env.AWS_ACCESS_KEY_ID = "AKIAEXAMPLE";
  process.env.AWS_SECRET_ACCESS_KEY = "secretzz";
  process.env.AWS_REGION = "us-east-2";
  try {
    const detected = detectCloudCreds().find((c) => c.provider === "bedrock");
    expect(detected?.aws?.region).toBe("us-east-2");
    const acc = await importCloudCred(detected!);
    expect(acc.auth.kind).toBe("aws");
    const creds = await resolveCreds(acc);
    expect(creds.aws).toMatchObject({ accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secretzz", region: "us-east-2" });
  } finally {
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_REGION;
  }
});

test("addAzureAccount accepts a resource endpoint and resolves Azure creds", async () => {
  const res = await addAzureAccount("https://myfoundry.openai.azure.com", "az-key", { apiVersion: "2024-10-21" });
  expect(res.ok).toBe(true);
  expect(res.account?.provider).toBe("azure");
  expect(res.account?.label).toBe("Azure (myfoundry)");
  expect(await resolveCreds(res.account!)).toEqual({ azure: { resourceName: "myfoundry", apiKey: "az-key", apiVersion: "2024-10-21" } });
});

test("addAzureFoundryAccount stores an OpenAI-compatible Foundry endpoint", async () => {
  const res = await addAzureFoundryAccount("https://myfoundry.services.ai.azure.com/api/projects/proj", "foundry-key");
  expect(res.ok).toBe(true);
  expect(res.account?.provider).toBe("azure-foundry");
  expect(res.account?.baseUrl).toBe("https://myfoundry.services.ai.azure.com/api/projects/proj/openai/v1");
  expect(await resolveCreds(res.account!)).toMatchObject({ apiKey: "foundry-key", baseURL: res.account?.baseUrl });
});

// ── P4: per-account usage/spend ledger ──
test("recordUsage accumulates spend, tokens, and turns per account", () => {
  recordUsage({ accountId: "anthropic-work", inputTokens: 100, outputTokens: 20, costUSD: 0.5, estimated: false });
  recordUsage({ accountId: "anthropic-work", inputTokens: 50, outputTokens: 10, costUSD: 0.25, estimated: true });
  recordUsage({ accountId: "claude-cli", inputTokens: 9000, outputTokens: 5, costUSD: 0.19, estimated: false });

  const work = accountUsage("anthropic-work")!;
  expect(work.spentUSD).toBeCloseTo(0.75, 5);
  expect(work.inputTokens).toBe(150);
  expect(work.turns).toBe(2);
  expect(work.estimated).toBe(true); // one turn was an estimate

  expect(totalSpent()).toBeCloseTo(0.94, 5);
  // sorted by spend, highest first
  expect(loadUsage()[0]!.accountId).toBe("anthropic-work");
});

test("recordRateLimits attaches quota snapshots to an account", () => {
  recordUsage({ accountId: "claude-cli", inputTokens: 1, outputTokens: 1, costUSD: 0.01, estimated: false });
  recordRateLimits("claude-cli", [{ utilization: 0.81, type: "seven_day", resetsAt: 1780718400 }]);
  expect(accountUsage("claude-cli")?.rate?.utilization).toBe(0.81);
  expect(accountUsage("claude-cli")?.rates?.[0]?.type).toBe("seven_day");
  // no-op for an unknown account (nothing to attach to)
  recordRateLimits("ghost", [{ utilization: 0.5 }]);
  expect(accountUsage("ghost")).toBeUndefined();
});

test("buildUsageView includes configured accounts without usage yet", () => {
  const view = buildUsageView(0, (id) => ({ name: id, kind: id.includes("cli") ? "sub" : "api", limitNote: "provider has not reported limits" }), Date.now(), ["claude-cli", "codex-cli", "anthropic"]);
  expect(view.subscriptions.map((a) => a.name)).toEqual(["claude-cli", "codex-cli"]);
  expect(view.subscriptions[0]?.turns).toBe(0);
  expect(view.subscriptions[0]?.limitNote).toBe("provider has not reported limits");
  expect(view.apiKeys.map((a) => a.name)).toContain("anthropic");
});

// ── plain-English labels + numbered list (no ids in the UI) ──
test("accountLabel reads in plain English; list is numbered", async () => {
  const { accountLabel, accountSlug, formatAccounts } = await import("../src/commands.ts");
  addCliAccount("claude-cli");
  addCliAccount("codex-cli", "personal");
  await addApiKeyAccount("anthropic", "sk-ant-x", { id: "anthropic-x" });
  expect(accountLabel(getAccount("claude-cli")!)).toBe("Claude · subscription");
  expect(accountLabel(getAccount("codex-cli-personal")!)).toBe("ChatGPT (personal) · subscription");
  expect(accountSlug(getAccount("codex-cli-personal")!)).toBe("chatgpt-personal");
  expect(accountLabel(getAccount("anthropic-x")!)).toBe("Anthropic · API key");
  const out = formatAccounts(listAccounts(), "claude-cli", []);
  expect(out).toContain("(or 1)"); // number remains a shortcut
  expect(out).toContain("/account chatgpt-personal"); // name alias is first-class
  expect(out).toContain("/account <name-or-number>");
  expect(out).not.toContain("<id>"); // ids are gone from the UI
});

// ── multiple accounts of the same kind ──
test("multiple CLI subscription accounts coexist via isolated config dirs", () => {
  const def = addCliAccount("claude-cli"); // default: system login, no profile
  const work = addCliAccount("claude-cli", "work"); // additional: own config dir
  const codex = addCliAccount("codex-cli", "personal");
  expect(def.account!.id).toBe("claude-cli");
  expect((def.account!.auth as any).loginProfile).toBeUndefined();
  expect(work.account!.id).toBe("claude-cli-work");
  expect((work.account!.auth as any).loginProfile).toContain("claude-cli-work");
  // all three are distinct, persisted accounts
  const ids = listAccounts().map((a) => a.id);
  expect(ids).toEqual(expect.arrayContaining(["claude-cli", "claude-cli-work", "codex-cli-personal"]));
});

test("subscriptionEnv strips the API key and scopes the config dir per account", () => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-should-be-stripped";
  try {
    const env = subscriptionEnv("claude", "/tmp/acct-x");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined(); // key stripped → uses subscription, not the (dead) key
    expect(env.CLAUDE_CONFIG_DIR).toBe("/tmp/acct-x"); // scoped to this account's login
    expect(subscriptionEnv("codex", "/tmp/cx").CODEX_HOME).toBe("/tmp/cx");
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

// multiple API keys per provider already work (unique ids):
test("multiple API-key accounts for one provider coexist", async () => {
  const a = await addApiKeyAccount("anthropic", "sk-ant-one", { id: "anthropic-a" });
  const b = await addApiKeyAccount("anthropic", "sk-ant-two", { id: "anthropic-b" });
  expect(a.account!.id).not.toBe(b.account!.id);
  expect(accountsForProvider("anthropic").length).toBeGreaterThanOrEqual(2);
});

test("secretRefs enumerates every secret an account owns", () => {
  const aws = mk({ id: "aws-1", provider: "bedrock", auth: { kind: "aws", accessKeyIdRef: "aws-1:akid", secretKeyRef: "aws-1:secret", sessionTokenRef: "aws-1:token", region: "us-east-2" } });
  expect(secretRefs(aws).sort()).toEqual(["aws-1:akid", "aws-1:secret", "aws-1:token"]);
  expect(secretRefs(mk())).toEqual(["anthropic-work:api-key"]);
});
