// ARM attempts are disabled here: these tests exercise the data-plane paths;
// the ARM control plane has its own suite (test/azure-arm.test.ts). This must be
// set before importing manage.ts (it's read at module load). It's a PROCESS-global
// env var, so restore it in afterAll — bun runs every test file in one process and
// a file discovered after this one (e.g. azure-arm) would otherwise inherit it.
const savedDisableAz = process.env.GEARBOX_DISABLE_AZ;
process.env.GEARBOX_DISABLE_AZ = "1";
import { test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gearbox-manage-"));
afterAll(() => {
  if (savedDisableAz === undefined) delete process.env.GEARBOX_DISABLE_AZ;
  else process.env.GEARBOX_DISABLE_AZ = savedDisableAz;
});
import {
  parseDeploymentDetails,
  parseAvailableBaseModels,
  listDeploymentDetails,
  listAvailableModels,
  createDeployment,
  deleteDeployment,
  terminalLink,
} from "../src/accounts/manage.ts";
import { addAzureAccount } from "../src/accounts/onboard.ts";
import type { Account } from "../src/accounts/types.ts";

// ── Pure parsers ──────────────────────────────────────────────────────────────

test("parseDeploymentDetails: standard azure response", () => {
  const json = {
    data: [
      { id: "gpt-4o", model: "gpt-4o", provisioningState: "Succeeded", scale_settings: { scale_type: "Standard" } },
      { id: "gpt-35", model: "gpt-35-turbo", provisioningState: "Failed",  scale_settings: { scale_type: "GlobalStandard" } },
    ],
  };
  const res = parseDeploymentDetails(json);
  expect(res).toHaveLength(2);
  expect(res[0]).toEqual({ id: "gpt-4o", model: "gpt-4o", status: "succeeded", capacityType: "Standard", capacityUnits: undefined });
  expect(res[1]).toEqual({ id: "gpt-35", model: "gpt-35-turbo", status: "failed", capacityType: "GlobalStandard", capacityUnits: undefined });
});

test("parseDeploymentDetails: sku capacity field for ProvisionedManaged", () => {
  const json = {
    data: [
      { id: "pm-dep", model: "gpt-4", sku: { name: "ProvisionedManaged", capacity: 100 } },
    ],
  };
  const res = parseDeploymentDetails(json);
  expect(res[0]!.capacityType).toBe("ProvisionedManaged");
  expect(res[0]!.capacityUnits).toBe(100);
});

test("parseDeploymentDetails: skips entries without an id", () => {
  const json = { data: [{ model: "gpt-4o" }, { id: "ok", model: "gpt-4o", provisioningState: "Running" }] };
  const res = parseDeploymentDetails(json);
  expect(res).toHaveLength(1);
  expect(res[0]!.id).toBe("ok");
  expect(res[0]!.status).toBe("running");
});

test("parseDeploymentDetails: handles missing or malformed data gracefully", () => {
  expect(parseDeploymentDetails(null)).toEqual([]);
  expect(parseDeploymentDetails({})).toEqual([]);
  expect(parseDeploymentDetails({ data: "not an array" })).toEqual([]);
});

test("parseAvailableBaseModels: returns chat model ids", () => {
  const json = {
    data: [
      { id: "gpt-4o" },
      { id: "gpt-4o-mini" },
      { id: "text-embedding-ada-002" }, // filtered
      { id: "dall-e-3" },               // filtered
      { id: "whisper-1" },              // filtered
      { id: "gpt-35-turbo" },
    ],
  };
  const res = parseAvailableBaseModels(json);
  expect(res).toContain("gpt-4o");
  expect(res).toContain("gpt-4o-mini");
  expect(res).toContain("gpt-35-turbo");
  expect(res).not.toContain("text-embedding-ada-002");
  expect(res).not.toContain("dall-e-3");
  expect(res).not.toContain("whisper-1");
});

test("parseAvailableBaseModels: deduplicates ids", () => {
  const json = { data: [{ id: "gpt-4o" }, { id: "gpt-4o" }] };
  expect(parseAvailableBaseModels(json)).toHaveLength(1);
});

test("parseAvailableBaseModels: returns [] for missing/malformed data", () => {
  expect(parseAvailableBaseModels(null)).toEqual([]);
  expect(parseAvailableBaseModels({ data: "nope" })).toEqual([]);
});

test("listDeploymentDetails: Foundry account with /openai/v1 baseUrl does not double the path", async () => {
  let capturedUrl = "";
  const mockFetch: typeof fetch = (async (url: string | URL | Request) => {
    capturedUrl = url.toString();
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as typeof fetch;

  // Simulate a Foundry account whose baseUrl already has /openai/v1 appended.
  const foundryAcc: import("../src/accounts/types.ts").Account = {
    id: "foundry-test",
    label: "Foundry",
    provider: "azure-foundry",
    exec: "in-loop",
    auth: { kind: "openai-compat", ref: "foundry-test:api-key" },
    baseUrl: "https://my-foundry.services.ai.azure.com/openai/v1",
    enabled: true,
    addedAt: Date.now(),
  };

  await listDeploymentDetails(foundryAcc, mockFetch);
  expect(capturedUrl).not.toContain("/openai/openai/");
  expect(capturedUrl).toContain("/openai/deployments");
});

test("createDeployment: services.ai host routes writes straight to ARM (no doomed data-plane PUTs)", async () => {
  let dataPlaneCalls = 0;
  const mockFetch: typeof fetch = (async (url: string | URL | Request) => {
    if (!url.toString().includes("management.azure.com")) dataPlaneCalls++;
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const acc: import("../src/accounts/types.ts").Account = {
    id: "foundry-arm-route-test", label: "Foundry", provider: "azure-foundry", exec: "in-loop",
    auth: { kind: "openai-compat", ref: "foundry-arm-route-test:api-key" },
    baseUrl: "https://my-foundry.services.ai.azure.com/openai/v1", enabled: true, addedAt: Date.now(),
  };
  const r = await createDeployment(acc, "my-dep", "gpt-4o", "Standard", mockFetch);
  expect(r.ok).toBe(false);
  expect(dataPlaneCalls).toBe(0); // no doomed data-plane writes
  expect(r.note).toMatch(/ARM management is disabled|az login|\/account login/);
});

test("createDeployment: gateway baseUrl with /openai/v1 does not double the path", async () => {
  let capturedUrl = "";
  const mockFetch: typeof fetch = (async (url: string | URL | Request) => {
    capturedUrl = url.toString();
    return new Response(JSON.stringify({}), { status: 201 });
  }) as typeof fetch;

  const foundryAcc: import("../src/accounts/types.ts").Account = {
    id: "foundry-create-test",
    label: "Foundry",
    provider: "azure-foundry",
    exec: "in-loop",
    auth: { kind: "openai-compat", ref: "foundry-create-test:api-key" },
    baseUrl: "https://my-gateway.example.com/openai/v1",
    enabled: true,
    addedAt: Date.now(),
  };

  await createDeployment(foundryAcc, "my-dep", "gpt-4o", "Standard", mockFetch);
  expect(capturedUrl).not.toContain("/openai/openai/");
  expect(capturedUrl).toContain("/openai/deployments/my-dep");
});

test("deleteDeployment: gateway baseUrl with /openai/v1 does not double the path", async () => {
  let capturedUrl = "";
  const mockFetch: typeof fetch = (async (url: string | URL | Request) => {
    capturedUrl = url.toString();
    return new Response("", { status: 204 });
  }) as typeof fetch;

  const foundryAcc: import("../src/accounts/types.ts").Account = {
    id: "foundry-delete-test",
    label: "Foundry",
    provider: "azure-foundry",
    exec: "in-loop",
    auth: { kind: "openai-compat", ref: "foundry-delete-test:api-key" },
    baseUrl: "https://my-gateway.example.com/openai/v1",
    enabled: true,
    addedAt: Date.now(),
  };

  await deleteDeployment(foundryAcc, "my-dep", mockFetch);
  expect(capturedUrl).not.toContain("/openai/openai/");
  expect(capturedUrl).toContain("/openai/deployments/my-dep");
});

test("createDeployment: Foundry inference endpoint returns helpful portal error", async () => {
  const inferenceAcc: import("../src/accounts/types.ts").Account = {
    id: "foundry-inference-test",
    label: "Foundry Inference",
    provider: "azure-foundry",
    exec: "in-loop",
    auth: { kind: "openai-compat", ref: "foundry-inference-test:api-key" },
    baseUrl: "https://my-project.eastus.inference.ai.azure.com/openai/v1",
    enabled: true,
    addedAt: Date.now(),
  };
  const r = await createDeployment(inferenceAcc, "my-dep", "gpt-4o", "Standard");
  expect(r.ok).toBe(false);
  expect(r.note).toMatch(/ARM management is disabled|az login/);
  expect(r.note).toContain("ai.azure.com");
});

test("deleteDeployment: Foundry inference endpoint returns helpful portal error", async () => {
  const inferenceAcc: import("../src/accounts/types.ts").Account = {
    id: "foundry-inference-del-test",
    label: "Foundry Inference",
    provider: "azure-foundry",
    exec: "in-loop",
    auth: { kind: "openai-compat", ref: "foundry-inference-del-test:api-key" },
    baseUrl: "https://my-project.eastus.inference.ai.azure.com/openai/v1",
    enabled: true,
    addedAt: Date.now(),
  };
  const r = await deleteDeployment(inferenceAcc, "my-dep");
  expect(r.ok).toBe(false);
  expect(r.note).toMatch(/ARM management is disabled|az login/);
});

test("terminalLink: wraps url in OSC 8 sequence", () => {
  const url = "https://portal.azure.com";
  const link = terminalLink(url);
  expect(link).toContain(url);
  expect(link).toContain("\x1b]8;;");
  expect(link).toContain("\x1b\\");
});

// ── Non-Azure no-ops ──────────────────────────────────────────────────────────

const nonAzureAccount: Account = {
  id: "anthropic-1",
  provider: "anthropic",
  label: "Anthropic",
  exec: "in-loop",
  auth: { kind: "api-key", ref: "anthropic-1:api-key" },
  enabled: true,
  addedAt: Date.now(),
};

test("listDeploymentDetails: returns empty for non-Azure account", async () => {
  const r = await listDeploymentDetails(nonAzureAccount);
  expect(r.ok).toBe(true);
  expect(r.deployments).toEqual([]);
});

test("listAvailableModels: returns empty for non-Azure account", async () => {
  const r = await listAvailableModels(nonAzureAccount);
  expect(r.ok).toBe(true);
  expect(r.models).toEqual([]);
});

test("createDeployment: no-op for non-Azure account", async () => {
  const r = await createDeployment(nonAzureAccount, "dep", "gpt-4o", "Standard");
  expect(r.ok).toBe(false);
  expect(r.note).toContain("not an Azure account");
});

test("deleteDeployment: no-op for non-Azure account", async () => {
  const r = await deleteDeployment(nonAzureAccount, "dep");
  expect(r.ok).toBe(false);
  expect(r.note).toContain("not an Azure account");
});

// ── Azure account with mock fetch ────────────────────────────────────────────

const makeFetch =
  (status: number, body: unknown): typeof fetch =>
  (async (_url, _opts) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as typeof fetch;

test("listDeploymentDetails: returns deployments on 200", async () => {
  const addResult = await addAzureAccount("my-resource", "sk-test-key-12345678");
  expect(addResult.ok).toBe(true);
  const acc = addResult.account!;
  const deployResponse = {
    data: [{ id: "gpt-4o", model: "gpt-4o", provisioningState: "Succeeded", scale_settings: { scale_type: "Standard" } }],
  };
  const r = await listDeploymentDetails(acc, makeFetch(200, deployResponse));
  expect(r.ok).toBe(true);
  expect(r.deployments).toHaveLength(1);
  expect(r.deployments[0]!.id).toBe("gpt-4o");
});

test("listDeploymentDetails: returns error note on 401", async () => {
  const addResult = await addAzureAccount("my-resource2", "sk-test-key-99887766");
  const acc = addResult.account!;
  const r = await listDeploymentDetails(acc, makeFetch(401, {}));
  expect(r.ok).toBe(false);
  expect(r.note).toContain("invalid or expired API key");
});

test("listAvailableModels: returns models on 200", async () => {
  const addResult = await addAzureAccount("my-resource3", "sk-test-key-55443322");
  const acc = addResult.account!;
  const modelsResponse = { data: [{ id: "gpt-4o" }, { id: "dall-e-3" }] };
  const r = await listAvailableModels(acc, makeFetch(200, modelsResponse));
  expect(r.ok).toBe(true);
  expect(r.models).toContain("gpt-4o");
  expect(r.models).not.toContain("dall-e-3");
});

test("createDeployment: returns ok on 200", async () => {
  const addResult = await addAzureAccount("my-resource4", "sk-test-key-11223344");
  const acc = addResult.account!;
  const r = await createDeployment(acc, "my-dep", "gpt-4o", "Standard", makeFetch(201, {}));
  expect(r.ok).toBe(true);
});

test("createDeployment: returns error note on 401", async () => {
  const addResult = await addAzureAccount("my-resource5", "sk-test-key-aabbccdd");
  const acc = addResult.account!;
  const r = await createDeployment(acc, "my-dep", "gpt-4o", "Standard", makeFetch(401, {}));
  expect(r.ok).toBe(false);
  expect(r.note).toContain("read-only key");
  expect(r.note).toContain("Cognitive Services Contributor");
});

test("deleteDeployment: returns ok on 200", async () => {
  const addResult = await addAzureAccount("my-resource6", "sk-test-key-xxyyzz11");
  const acc = addResult.account!;
  const r = await deleteDeployment(acc, "my-dep", makeFetch(204, {}));
  expect(r.ok).toBe(true);
});

test("deleteDeployment: 404 naming the deployment = already gone (success)", async () => {
  const addResult = await addAzureAccount("my-resource7", "sk-test-key-ffeeddcc");
  const acc = addResult.account!;
  const r = await deleteDeployment(acc, "my-dep", makeFetch(404, { error: { code: "DeploymentNotFound", message: "The API deployment for this resource does not exist." } }));
  expect(r.ok).toBe(true);
});

test("deleteDeployment: generic route-404 on every api-version is an honest failure, not success", async () => {
  // The old behavior treated ANY 404 as "already deleted" — including the
  // route-doesn't-exist-on-this-api-version 404, which made deletes look
  // successful while the deployment lived on.
  const addResult = await addAzureAccount("my-resource8", "sk-test-key-11aa22bb");
  const acc = addResult.account!;
  const r = await deleteDeployment(acc, "my-dep", makeFetch(404, { error: { code: "404", message: "Resource not found" } }));
  expect(r.ok).toBe(false);
  expect(r.note).toMatch(/ARM management is disabled|az login|\/account login/);
});

// ── The v0.2.93 deploy 404: management routes live on the AUTHORING api-version ──

test("createDeployment: PUTs the authoring api-version first (the stored inference version 404s)", async () => {
  const addResult = await addAzureAccount("my-resource9", "sk-test-key-33cc44dd");
  const acc = addResult.account!;
  const urls: string[] = [];
  const mockFetch: typeof fetch = (async (url: string | URL | Request) => {
    urls.push(url.toString());
    return new Response(JSON.stringify({}), { status: 201 });
  }) as typeof fetch;
  const r = await createDeployment(acc, "my-dep", "gpt-4o", "Standard", mockFetch);
  expect(r.ok).toBe(true);
  expect(urls).toHaveLength(1);
  expect(urls[0]).toContain("api-version=2023-03-15-preview");
});

test("createDeployment: falls back to the stored api-version when the authoring route 404s", async () => {
  const addResult = await addAzureAccount("my-resource10", "sk-test-key-55ee66ff");
  const acc = addResult.account!;
  const urls: string[] = [];
  const mockFetch: typeof fetch = (async (url: string | URL | Request) => {
    urls.push(url.toString());
    const is404 = url.toString().includes("2023-03-15-preview");
    return new Response(JSON.stringify(is404 ? { error: { code: "404", message: "Resource not found" } } : {}), { status: is404 ? 404 : 201 });
  }) as typeof fetch;
  const r = await createDeployment(acc, "my-dep", "gpt-4o", "Standard", mockFetch);
  expect(r.ok).toBe(true);
  expect(urls).toHaveLength(2);
  expect(urls[1]).not.toContain("2023-03-15-preview");
});

test("createDeployment: 404 on every version reports the portal path, not a raw error dump", async () => {
  const addResult = await addAzureAccount("my-resource11", "sk-test-key-77gg88hh");
  const acc = addResult.account!;
  const r = await createDeployment(acc, "my-dep", "gpt-4o", "Standard", makeFetch(404, { error: { code: "404", message: "Resource not found" } }));
  expect(r.ok).toBe(false);
  expect(r.note).toMatch(/ARM management is disabled|az login|\/account login/);
});

test("createDeployment: a Standard deploy sends the legacy authoring body (lowercase scale_type)", async () => {
  const addResult = await addAzureAccount("my-resource12", "sk-test-key-99ii00jj");
  const acc = addResult.account!;
  let body = "";
  const mockFetch: typeof fetch = (async (_url: string | URL | Request, opts: any) => {
    body = String(opts?.body ?? "");
    return new Response(JSON.stringify({}), { status: 201 });
  }) as typeof fetch;
  await createDeployment(acc, "my-dep", "gpt-4o", "Standard", mockFetch);
  const parsed = JSON.parse(body);
  expect(parsed.model).toBe("gpt-4o");
  expect(parsed.scale_settings).toEqual({ scale_type: "standard" });
  expect(parsed.sku).toBeUndefined();
});
