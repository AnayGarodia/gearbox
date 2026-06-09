import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gearbox-manage-"));
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

test("createDeployment: Foundry account with /openai/v1 baseUrl does not double the path", async () => {
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
    baseUrl: "https://my-foundry.services.ai.azure.com/openai/v1",
    enabled: true,
    addedAt: Date.now(),
  };

  await createDeployment(foundryAcc, "my-dep", "gpt-4o", "Standard", mockFetch);
  expect(capturedUrl).not.toContain("/openai/openai/");
  expect(capturedUrl).toContain("/openai/deployments/my-dep");
});

test("deleteDeployment: Foundry account with /openai/v1 baseUrl does not double the path", async () => {
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
    baseUrl: "https://my-foundry.services.ai.azure.com/openai/v1",
    enabled: true,
    addedAt: Date.now(),
  };

  await deleteDeployment(foundryAcc, "my-dep", mockFetch);
  expect(capturedUrl).not.toContain("/openai/openai/");
  expect(capturedUrl).toContain("/openai/deployments/my-dep");
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

test("deleteDeployment: treats 404 as success (already gone)", async () => {
  const addResult = await addAzureAccount("my-resource7", "sk-test-key-ffeeddcc");
  const acc = addResult.account!;
  const r = await deleteDeployment(acc, "my-dep", makeFetch(404, {}));
  expect(r.ok).toBe(true);
});
