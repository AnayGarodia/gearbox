// The classic-Azure client config policy: which URL surface a stored
// apiVersion selects. Blank must mean the battle-tested GA deployments API —
// the old default bet every turn on the young /openai/v1 surface and broke
// inference on resources that don't serve it yet.
import { test, expect } from "bun:test";
import { azureClientConfig, AZURE_GA_API_VERSION } from "../src/providers.ts";

test("blank apiVersion → GA version + deployment-based URLs (the safe default)", () => {
  const c = azureClientConfig({ resourceName: "my-res", apiKey: "k" });
  expect(c).toEqual({ resourceName: "my-res", apiKey: "k", apiVersion: AZURE_GA_API_VERSION, useDeploymentBasedUrls: true });
  // whitespace-only counts as blank
  expect(azureClientConfig({ apiVersion: "  " }).apiVersion).toBe(AZURE_GA_API_VERSION);
});

test("a dated apiVersion passes through with deployment-based URLs", () => {
  const c = azureClientConfig({ resourceName: "r", apiKey: "k", apiVersion: "2024-08-01-preview" });
  expect(c.apiVersion).toBe("2024-08-01-preview");
  expect(c.useDeploymentBasedUrls).toBe(true);
});

test('the literal "v1" opts into the SDK\'s modern /openai/v1 surface', () => {
  const c = azureClientConfig({ resourceName: "r", apiKey: "k", apiVersion: "v1" });
  expect(c.apiVersion).toBeUndefined();
  expect(c.useDeploymentBasedUrls).toBeUndefined();
});
