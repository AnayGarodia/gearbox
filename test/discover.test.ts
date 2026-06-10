import { test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAzureDeployments, parseOpenAIModels, discoverModels } from "../src/accounts/discover.ts";
import { putAccount } from "../src/accounts/store.ts";
import { addAzureAccount, addAzureFoundryAccount, addApiKeyAccount } from "../src/accounts/onboard.ts";
import { MODELS, modelRegistry } from "../src/providers.ts";
import { unavailableModelHint } from "../src/agent/run.ts";
import type { Account } from "../src/accounts/types.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "gearbox-disc-"));
  process.env.GEARBOX_HOME = home;
  process.env.GEARBOX_SECRET_STORE = "file";
});
afterAll(() => {
  delete process.env.GEARBOX_HOME;
  delete process.env.GEARBOX_SECRET_STORE;
});

// A fetch double that maps URL substrings to canned JSON bodies.
function fakeFetch(routes: { match: string; status?: number; body: unknown }[]) {
  return async (url: string | URL): Promise<Response> => {
    const u = String(url);
    const hit = routes.find((r) => u.includes(r.match));
    const status = hit?.status ?? (hit ? 200 : 404);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => hit?.body ?? { error: "not found" },
    } as unknown as Response;
  };
}

// ── pure parsers ──
test("parseAzureDeployments returns deployment ids and drops non-chat families", () => {
  const body = {
    data: [
      { id: "gpt-4o", model: "gpt-4o-2024-08-06" },
      { id: "my-mini", model: "gpt-4o-mini" },
      { id: "text-embedding-3-small", model: "text-embedding-3-small" },
      { id: "dalle", model: "dall-e-3" },
      { id: "voice", model: "whisper" },
    ],
  };
  expect(parseAzureDeployments(body)).toEqual(["gpt-4o", "my-mini"]);
  // tolerant of junk
  expect(parseAzureDeployments({})).toEqual([]);
  expect(parseAzureDeployments(null)).toEqual([]);
});

test("parseOpenAIModels keeps chat-capable, drops deprecated, dedups", () => {
  const body = {
    data: [
      { id: "gpt-5-2025-08-07", capabilities: { chat_completion: true }, lifecycle_status: "generally-available" },
      { id: "o4-mini-2025-04-16", capabilities: { chat_completion: true }, lifecycle_status: "generally-available" },
      { id: "old-chat", capabilities: { chat_completion: true }, lifecycle_status: "deprecated" },
      { id: "dall-e-3-3.0", capabilities: { chat_completion: false }, lifecycle_status: "preview" },
      { id: "gpt-5-2025-08-07", capabilities: { chat_completion: true } }, // dup
    ],
  };
  expect(parseOpenAIModels(body)).toEqual(["gpt-5-2025-08-07", "o4-mini-2025-04-16"]);
});

test("parseOpenAIModels keeps all ids when the endpoint has no capability field (generic OpenAI-wire)", () => {
  const body = { data: [{ id: "llama-3.3-70b-versatile" }, { id: "qwen-qwq-32b" }] };
  expect(parseOpenAIModels(body)).toEqual(["llama-3.3-70b-versatile", "qwen-qwq-32b"]);
});

// ── discoverModels (per-provider routing of the right endpoint) ──
test("discoverModels lists Azure OpenAI deployments via the 2023-03-15-preview list route", async () => {
  const res = await addAzureAccount("aztea-aoai", "az-key");
  const f = fakeFetch([
    { match: "/openai/deployments?api-version=2023-03-15-preview", body: { data: [{ id: "gpt-4o", model: "gpt-4o" }, { id: "emb", model: "text-embedding-3-small" }] } },
  ]);
  const d = await discoverModels(res.account!, f as unknown as typeof fetch);
  expect(d.ok).toBe(true);
  expect(d.models).toEqual(["gpt-4o"]);
});

test("discoverModels lists Foundry / openai-compat chat models from /models", async () => {
  const res = await addAzureFoundryAccount("https://aztea-foundry.services.ai.azure.com", "f-key");
  const f = fakeFetch([
    { match: "/openai/v1/models", body: { data: [
      { id: "gpt-5-2025-08-07", capabilities: { chat_completion: true }, lifecycle_status: "generally-available" },
      { id: "whisper-001", capabilities: { chat_completion: false }, lifecycle_status: "generally-available" },
    ] } },
  ]);
  const d = await discoverModels(res.account!, f as unknown as typeof fetch);
  expect(d.ok).toBe(true);
  expect(d.models).toEqual(["gpt-5-2025-08-07"]);
});

test("discoverModels reports a note (not a throw) when the endpoint errors", async () => {
  const res = await addApiKeyAccount("groq", "gsk_x");
  const f = fakeFetch([{ match: "/models", status: 401, body: { error: { message: "bad key" } } }]);
  const d = await discoverModels(res.account!, f as unknown as typeof fetch);
  expect(d.ok).toBe(false);
  expect(d.note).toBeTruthy();
});

// ── status-specific Azure discovery notes (401 and 404 need OPPOSITE fixes) ──
import { azureListNote } from "../src/accounts/discover.ts";

test("azureListNote distinguishes 401/403/404 per provider", () => {
  expect(azureListNote(401, "azure")).toContain("key rejected");
  expect(azureListNote(403, "azure")).toContain("firewall");
  expect(azureListNote(404, "azure")).toContain("Foundry endpoint");
  expect(azureListNote(404, "azure-foundry")).toContain("HTTP 404");
  expect(azureListNote(500, "azure")).toContain("HTTP 500");
});

test("classic azure discovery failure carries the status-specific note", async () => {
  const res = await addAzureAccount("aztea-aoai", "az-key");
  const f401 = fakeFetch([{ match: "/openai/deployments", status: 401, body: {} }]);
  const d = await discoverModels(res.account!, f401 as unknown as typeof fetch);
  expect(d.ok).toBe(false);
  expect(d.note).toContain("key rejected");
});

// THE Foundry trust fix: an OK deployments answer is authoritative even when
// EMPTY. Falling through to /models used to persist the resource's deployable
// CATALOG (hundreds of ids) as callable models — all of which 404 at inference.
test("Foundry: an empty deployments list is trusted — the /models catalog is NOT dumped", async () => {
  const res = await addAzureFoundryAccount("https://aztea-foundry.services.ai.azure.com", "f-key");
  const hits: string[] = [];
  const inner = fakeFetch([
    { match: "/openai/deployments", body: { data: [] } },
    { match: "/models", body: { data: [{ id: "catalog-model-1", capabilities: { chat_completion: true } }] } },
  ]);
  const f = (async (url: string | URL) => { hits.push(String(url)); return inner(url); }) as unknown as typeof fetch;
  const d = await discoverModels(res.account!, f);
  expect(d.ok).toBe(true);
  expect(d.models).toEqual([]);
  expect(d.note).toContain("no chat deployments yet");
  expect(hits.some((u) => /\/models(\?|$)/.test(u))).toBe(false); // catalog never consulted
});

test("Foundry: a 401 on the deployments route is a credential error, not a fallback", async () => {
  const res = await addAzureFoundryAccount("https://aztea-foundry.services.ai.azure.com", "f-key");
  const f = fakeFetch([
    { match: "/openai/deployments", status: 401, body: {} },
    { match: "/models", body: { data: [{ id: "catalog-model-1", capabilities: { chat_completion: true } }] } },
  ]);
  const d = await discoverModels(res.account!, f as unknown as typeof fetch);
  expect(d.ok).toBe(false);
  expect(d.models).toEqual([]);
  expect(d.note).toContain("key rejected");
});

// ── one router for Azure adds: a Foundry-shaped URL never mints a classic account ──
test("addAzureAccount delegates URL-shaped Foundry endpoints to the foundry path", async () => {
  const r = await addAzureAccount("https://my-proj.services.ai.azure.com", "k-1234567890");
  expect(r.ok).toBe(true);
  expect(r.account!.provider).toBe("azure-foundry");
  expect(r.account!.baseUrl).toContain("my-proj.services.ai.azure.com");
  // a bare resource name (or a classic URL) still mints a classic account
  const c = await addAzureAccount("my-res", "k-1234567890");
  expect(c.account!.provider).toBe("azure");
  const c2 = await addAzureAccount("https://my-res.openai.azure.com", "k-1234567890");
  expect(c2.account!.provider).toBe("azure");
});

// ── honest registry: no fabricated seeds for discoverOnly providers ──
test("Azure / Foundry seed models are NOT advertised as ready-to-use", () => {
  // the catalog seeds (gpt-5.5, o4-mini, ...) must not appear as selectable models
  expect(MODELS.some((m) => m.provider === "azure")).toBe(false);
  expect(MODELS.some((m) => m.provider === "azure-foundry")).toBe(false);
  // but non-discoverOnly openai-compat seeds still generate (e.g. groq)
  expect(MODELS.some((m) => m.id === "groq/llama-3.3-70b-versatile")).toBe(true);
});

test("discovered models surface in the registry via account.models", async () => {
  const res = await addAzureFoundryAccount("https://aztea-foundry.services.ai.azure.com", "f-key");
  putAccount({ ...res.account!, models: ["gpt-5-2025-08-07", "o4-mini-2025-04-16"] });
  const reg = modelRegistry();
  expect(reg.some((m) => m.id === "azure-foundry/gpt-5-2025-08-07" && m.provider === "azure-foundry")).toBe(true);
  expect(reg.some((m) => m.sdkId === "o4-mini-2025-04-16")).toBe(true);
});

test("a discovered model set overrides catalog seeds for ANY provider (not just Azure)", async () => {
  // before discovery: groq shows its catalog seed examples
  expect(modelRegistry().some((m) => m.id === "groq/llama-3.3-70b-versatile" && m.capabilities?.source === "seeded")).toBe(true);
  // after an account reports its real list, the seeds for that provider drop out
  const res = await addApiKeyAccount("groq", "gsk_x");
  putAccount({ ...res.account!, models: ["llama-3.3-70b-versatile", "moonshotai/kimi-k2"] });
  const reg = modelRegistry();
  expect(reg.some((m) => m.provider === "groq" && m.capabilities?.source === "seeded")).toBe(false); // seeds gone
  expect(reg.some((m) => m.sdkId === "moonshotai/kimi-k2")).toBe(true); // real model present
  // the shared id now resolves to the discovered spec, not the seed
  expect(reg.find((m) => m.provider === "groq" && m.sdkId === "llama-3.3-70b-versatile")?.capabilities?.source).toBe("api-discovered");
});

// ── friendlier "model not served" — general across providers ──
test("unavailableModelHint rewrites model-not-found for ANY non-native provider", () => {
  const azure = { id: "azure/o4-mini", provider: "azure", sdkId: "o4-mini", label: "o4-mini", contextWindow: 128_000 };
  const out = unavailableModelHint("The API deployment for this resource does not exist.", azure as any);
  expect(out).toContain("o4-mini");
  expect(out).toContain("/account refresh");
  // a gateway with a retired model id gets the same treatment
  const groq = { id: "groq/old", provider: "groq", sdkId: "old-model", label: "old", contextWindow: 1 };
  expect(unavailableModelHint("model_not_found: old-model", groq as any)).toContain("/account refresh");
  // native providers and unrelated errors pass through untouched
  const anth = { id: "claude", provider: "anthropic", sdkId: "claude", label: "c", contextWindow: 1 };
  expect(unavailableModelHint("model not found", anth as any)).toBe("model not found");
  expect(unavailableModelHint("rate limited", groq as any)).toBe("rate limited");
});

test("discoverModels is a no-op for native and cli providers", async () => {
  const native = await addApiKeyAccount("anthropic", "sk-ant-x");
  expect((await discoverModels(native.account!)).models).toEqual([]);
  const cli: Account = { id: "claude-cli", label: "Claude", provider: "claude-cli", exec: "cli", auth: { kind: "cli", binary: "claude" }, enabled: true, addedAt: 1 };
  putAccount(cli);
  expect((await discoverModels(cli)).models).toEqual([]);
});
