import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gearbox-addspec-"));
import { ADD_SPECS, specFor, filterAddSpecs, buildPaletteAddRows, buildAddGuidance } from "../src/accounts/add-spec.ts";

test("specFor resolves curated providers and aliases", () => {
  expect(specFor("azure")!.id).toBe("azure");
  expect(specFor("AWS")!.id).toBe("bedrock"); // alias, case-insensitive
  expect(specFor("chatgpt")!.id).toBe("codex-subscription");
  expect(specFor("claude")!.id).toBe("claude-subscription");
  expect(specFor("foundry")!.id).toBe("azure-foundry");
  expect(specFor("custom")!.id).toBe("openai-compat");
});

test("specFor synthesizes a key spec for an uncurated catalog provider", () => {
  const m = specFor("mistral"); // not in ADD_SPECS, but a catalog openai-compat with baseUrl
  expect(m).toBeDefined();
  expect(m!.id).toBe("mistral");
  expect(m!.fields).toHaveLength(1);
  expect(m!.fields[0]!.key).toBe("apiKey");
});

test("specFor points an uncurated keyless openai-compat at the generic compat spec", () => {
  expect(specFor("litellm")!.id).toBe("openai-compat"); // litellm has no baseUrl in the catalog
});

test("specFor returns undefined for an unknown provider", () => {
  expect(specFor("totally-made-up")).toBeUndefined();
});

test("field validators catch bad input and accept good input", () => {
  const bedrock = specFor("bedrock")!;
  const accessKey = bedrock.fields.find((f) => f.key === "accessKeyId")!;
  expect(accessKey.validate("nope")).toBeTruthy();
  expect(accessKey.validate("AKIAIOSFODNN7EXAMPLE")).toBeNull();
  const region = bedrock.fields.find((f) => f.key === "region")!;
  expect(region.validate("us-east-1")).toBeNull();
  expect(region.validate("east")).toBeTruthy();

  const vertex = specFor("vertex")!;
  const sa = vertex.fields.find((f) => f.key === "serviceAccountJson")!;
  expect(sa.validate("")).toBeNull(); // optional → ADC
  expect(sa.validate("{not json")).toBeTruthy();
  expect(sa.validate('{"type":"service_account"}')).toBeNull();
});

test("filterAddSpecs narrows by query", () => {
  const az = filterAddSpecs("azure"); // "az" also matches "Amazon" — substring is intentional
  expect(az.map((s) => s.id).sort()).toEqual(["azure", "azure-foundry"]);
  expect(filterAddSpecs("").length).toBe(ADD_SPECS.length);
});

test("buildPaletteAddRows covers cloud providers and the subscription second-account quick-starts", () => {
  const rows = buildPaletteAddRows();
  const commands = rows.map((r) => r.command);
  expect(commands).toContain("/account add azure");
  expect(commands).toContain("/account add bedrock");
  expect(commands).toContain("/account add vertex");
  expect(commands).toContain("/account add claude work");
  expect(commands).toContain("/account add"); // generic paste row
});

test("buildAddGuidance gives field-by-field help, an example, a signup link and the Azure disambiguation", () => {
  const g = buildAddGuidance("azure", "usage: /account add azure …");
  expect(g).toContain("usage: /account add azure"); // raw message preserved
  expect(g).toContain("Azure OpenAI needs:");
  expect(g).toContain("Resource name");
  expect(g).toContain("e.g."); // an example
  expect(g).toContain("Foundry:"); // disambiguation
  expect(g).toContain("Get a key → ");
  expect(g).toContain('"+ add an account"'); // wizard escape hatch
});

test("buildAddGuidance lists providers for an unknown one", () => {
  const g = buildAddGuidance("nonsense", "couldn't identify that");
  expect(g).toContain("couldn't identify that");
  expect(g).toContain("/account add azure");
  expect(g).toContain("+ add an account");
});
