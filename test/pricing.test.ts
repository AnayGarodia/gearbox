import { test, expect, describe } from "bun:test";
import { priceFor, listPriceFor } from "../src/model/pricing.ts";

describe("priceFor — exact + provider scope", () => {
  test("native DeepSeek vs Foundry-hosted DeepSeek price differently (the whole point)", () => {
    expect(priceFor("deepseek", "deepseek-v4-pro")!.out).toBe(0.87);
    const foundry = priceFor("azure-foundry", "DeepSeek-V4-Pro")!;
    expect(foundry.out).toBe(3.828);
    expect(foundry.src).toBe("live");
  });

  test("Kimi on Foundry uses the live Foundry rate", () => {
    expect(priceFor("azure-foundry", "Kimi-K2.6")!.in).toBe(1.045);
  });

  test("headline models the registry didn't curate now have prices", () => {
    expect(listPriceFor("openai", "gpt-5.3-codex")).toEqual({ inUSDPerMtok: 1.75, outUSDPerMtok: 14 });
    expect(listPriceFor("openai", "gpt-5.4-nano")).toEqual({ inUSDPerMtok: 0.2, outUSDPerMtok: 1.25 });
    expect(listPriceFor("xai", "grok-4.3")).toEqual({ inUSDPerMtok: 1.25, outUSDPerMtok: 2.5 });
    expect(listPriceFor("xai", "grok-code-fast-1")).toEqual({ inUSDPerMtok: 0.2, outUSDPerMtok: 1.5 });
    expect(listPriceFor("moonshot", "kimi-k2.6")).toEqual({ inUSDPerMtok: 0.95, outUSDPerMtok: 4 });
    expect(listPriceFor("zai", "glm-4.6")).toEqual({ inUSDPerMtok: 0.6, outUSDPerMtok: 2.2 });
    expect(listPriceFor("mistral", "mistral-large-3")).toEqual({ inUSDPerMtok: 0.5, outUSDPerMtok: 1.5 });
  });
});

describe("priceFor — containment match for deployment/gateway ids", () => {
  test("a deployment named after a family resolves to that family's price", () => {
    expect(priceFor("azure-foundry", "team-gpt-5.4-nano-eastus2")!.out).toBe(1.25);
    expect(priceFor("openrouter", "openai/gpt-5.3-codex")!.out).toBe(14);
  });

  test("a tiered variant does NOT inherit the base price", () => {
    // "gpt-5.4-nano" must not match "gpt-5.4" (different price tier).
    expect(priceFor("openai", "gpt-5.4-nano")!.out).toBe(1.25); // its own entry, not gpt-5.4's 15
    // a tiered variant with no own entry stays unknown rather than billing the base:
    // "grok-3-turbo" must NOT inherit grok-3's price (turbo is a tier modifier).
    expect(priceFor("xai", "grok-3-turbo")).toBeUndefined();
  });

  test("gpt-5.5-pro beats gpt-5.5 (longest match wins)", () => {
    expect(priceFor("openai", "gpt-5.5-pro")!.out).toBe(180);
    expect(priceFor("openai", "gpt-5.5")!.out).toBe(30);
  });
});

describe("priceFor — Perplexity per-request fee captured", () => {
  test("sonar carries a per-request search fee the token rate alone misses", () => {
    const p = priceFor("perplexity", "sonar")!;
    expect(p.perRequestUSD).toBeGreaterThan(0);
  });
});

describe("priceFor — honest unknown", () => {
  test("a truly unknown model returns undefined (not $0)", () => {
    expect(priceFor("openai", "some-unreleased-model-xyz")).toBeUndefined();
  });
});
