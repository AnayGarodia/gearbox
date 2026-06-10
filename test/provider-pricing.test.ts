// Pricing fallback for discovered deployments + the subscription-seat namespace
// guard. Discovered Azure/Foundry deployment ids carry no price data, so cost
// showed "$ unknown" even for a deployment plainly named after a known family;
// canonicalPricingFor maps those to the family list price and stays honestly
// unknown otherwise. binaryServesModel keeps a vendor CLI seat from ever being
// minted for a model its binary can't run.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalPricingFor, binaryServesModel, subscriptionSeats, modelRegistry, hasPricing, estimateCost } from "../src/providers.ts";
import { putAccount } from "../src/accounts/store.ts";

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved.GEARBOX_HOME = process.env.GEARBOX_HOME;
  process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gearbox-pricing-"));
});
afterEach(() => {
  if (saved.GEARBOX_HOME === undefined) delete process.env.GEARBOX_HOME;
  else process.env.GEARBOX_HOME = saved.GEARBOX_HOME;
});

test("canonical family names match regardless of case", () => {
  expect(canonicalPricingFor("DeepSeek-V4-Pro")).toEqual({ inUSDPerMtok: 0.4, outUSDPerMtok: 1.75 });
  expect(canonicalPricingFor("deepseek-v4-pro")).toEqual({ inUSDPerMtok: 0.4, outUSDPerMtok: 1.75 });
});

test("deployment names embedding a family at a boundary match (longest family wins)", () => {
  expect(canonicalPricingFor("my-gpt-5.5-eastus2")).toEqual({ inUSDPerMtok: 2.5, outUSDPerMtok: 10 });
  // gpt-5.5-pro must price as -pro, never as the shorter gpt-5.5 prefix.
  expect(canonicalPricingFor("gpt-5.5-pro")).toEqual({ inUSDPerMtok: 15, outUSDPerMtok: 120 });
});

test("trailing date stamps are stripped before matching", () => {
  expect(canonicalPricingFor("claude-sonnet-4-6-20250115")).toEqual({ inUSDPerMtok: 3, outUSDPerMtok: 15 });
});

test("a different price TIER of a family refuses the match (honest unknown)", () => {
  // "-mini" is cheaper than gpt-5.5 base — billing the base rate would be wrong.
  expect(canonicalPricingFor("gpt-5.5-mini")).toBeUndefined();
  expect(canonicalPricingFor("my-gpt-5.5-nano-deploy")).toBeUndefined();
});

test("genuinely unknown deployments stay unknown", () => {
  expect(canonicalPricingFor("totally-custom-model")).toBeUndefined();
  expect(canonicalPricingFor("")).toBeUndefined();
  // substring without a boundary must NOT match ("notgpt-5.5x" is not gpt-5.5)
  expect(canonicalPricingFor("xgpt-5.5x")).toBeUndefined();
});

test("a discovered Foundry deployment gets family pricing in the registry", () => {
  putAccount({
    id: "af-1", label: "Foundry", provider: "azure-foundry", exec: "in-loop",
    auth: { kind: "openai-compat", ref: "af-1:api-key" }, baseUrl: "https://r.services.ai.azure.com/openai/v1",
    models: ["DeepSeek-V4-Pro", "my-bespoke-finetune"], enabled: true, addedAt: 0,
  });
  const reg = modelRegistry();
  const ds = reg.find((m) => m.id === "azure-foundry/DeepSeek-V4-Pro");
  expect(ds?.cost).toEqual({ inUSDPerMtok: 0.4, outUSDPerMtok: 1.75 });
  expect(hasPricing("azure-foundry/DeepSeek-V4-Pro")).toBe(true);
  expect(estimateCost([{ model: "azure-foundry/DeepSeek-V4-Pro", inputTokens: 1_000_000, outputTokens: 0 }])).toBeCloseTo(0.4);
  // the unmatched deployment keeps its honest unknown
  const bespoke = reg.find((m) => m.id === "azure-foundry/my-bespoke-finetune");
  expect(bespoke?.cost).toBeUndefined();
  expect(hasPricing("azure-foundry/my-bespoke-finetune")).toBe(false);
});

test("binaryServesModel: vendor namespaces", () => {
  expect(binaryServesModel("claude", "claude-sonnet-4-6")).toBe(true);
  expect(binaryServesModel("claude", "gpt-5.5")).toBe(false);
  expect(binaryServesModel("codex", "gpt-5.5")).toBe(true);
  expect(binaryServesModel("codex", "o4-mini")).toBe(true);
  expect(binaryServesModel("codex", "claude-opus-4-8")).toBe(false);
  expect(binaryServesModel("somefuture", "anything")).toBe(true); // unknown vendor: don't block
});

test("a polluted CLI account snapshot never mints a seat the binary can't serve", () => {
  putAccount({
    id: "claude-poll", label: "Claude Max", provider: "claude-cli", exec: "cli",
    auth: { kind: "cli", binary: "claude" },
    models: ["claude-sonnet-4-6", "gpt-5.5"], // foreign id snuck into the snapshot
    enabled: true, addedAt: 0,
  });
  const ids = subscriptionSeats().filter((s) => s.account.id === "claude-poll").map((s) => s.spec.sdkId);
  expect(ids).toContain("claude-sonnet-4-6");
  expect(ids).not.toContain("gpt-5.5"); // `claude --model gpt-5.5` would fail at turn time
});
