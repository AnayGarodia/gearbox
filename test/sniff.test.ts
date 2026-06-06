import { test, expect } from "bun:test";
import { sniffCredential } from "../src/accounts/sniff.ts";

test("detects API keys by prefix", () => {
  expect(sniffCredential("sk-ant-abc123")).toMatchObject({ kind: "api-key", provider: "anthropic" });
  expect(sniffCredential("sk-proj-abc")).toMatchObject({ kind: "api-key", provider: "openai" });
  expect(sniffCredential("AIzaSyABC")).toMatchObject({ kind: "api-key", provider: "google" });
  expect(sniffCredential("sk-or-v1-abc")).toMatchObject({ kind: "openai-compat", provider: "openrouter" });
});

test("detects an AWS access key id", () => {
  const g = sniffCredential("AKIAIOSFODNN7EXAMPLE");
  expect(g.kind).toBe("aws");
  expect(g.provider).toBe("bedrock");
  expect(g.missing).toContain("secretAccessKey");
});

test("detects a pasted AWS credentials block", () => {
  const g = sniffCredential("aws_access_key_id=AKIAIOSFODNN7EXAMPLE\naws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
  expect(g.kind).toBe("aws");
  expect(g.fields.accessKeyId).toBe("AKIAIOSFODNN7EXAMPLE");
  expect(g.fields.secretAccessKey).toContain("wJalrXUtnFEMI");
  expect(g.missing).not.toContain("secretAccessKey");
});

test("detects a Vertex service-account JSON", () => {
  const json = JSON.stringify({ type: "service_account", project_id: "my-proj", private_key: "x" });
  const g = sniffCredential(json);
  expect(g.kind).toBe("vertex");
  expect(g.fields.project).toBe("my-proj");
});

test("detects an Azure endpoint", () => {
  const g = sniffCredential("https://my-resource.openai.azure.com");
  expect(g.kind).toBe("azure");
  expect(g.fields.resourceName).toBe("my-resource");
  expect(g.missing).toContain("apiKey");
});

test("detects a Vercel AI Gateway key", () => {
  const g = sniffCredential("vck_abcdEFGHijkl");
  expect(g.kind).toBe("openai-compat");
  expect(g.provider).toBe("vercel-gateway");
});

test("unknown bearer → unknown, low confidence", () => {
  const g = sniffCredential("zzz-some-random-token-1234567890");
  expect(g.kind).toBe("unknown");
  expect(g.confidence).toBe("low");
});
