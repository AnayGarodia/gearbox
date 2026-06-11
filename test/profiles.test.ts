import { test, expect, describe } from "bun:test";
import { PROFILES, profileFor, PROVIDER_CALIBRATION, outputFactorFor, OUTPUT_FACTOR_DEFAULT, cacheReadDiscount } from "../src/model/profiles.ts";

// ── 1. profileFor('claude-sonnet-4-6') returns the correct profile fields ─────

describe("profileFor('claude-sonnet-4-6')", () => {
  const profile = profileFor("claude-sonnet-4-6");

  test("returns a defined value", () => {
    expect(profile).toBeDefined();
  });

  test("has provider=anthropic", () => {
    expect(profile!.provider).toBe("anthropic");
  });

  test("has contextWindow=1_000_000", () => {
    expect(profile!.contextWindow).toBe(1_000_000);
  });

  test("has maxOutput=64_000", () => {
    expect(profile!.maxOutput).toBe(64_000);
  });

  test("has tokenizer.calibration=1.35", () => {
    expect(profile!.tokenizer.calibration).toBe(1.35);
  });

  test("has tokenizer.family='claude'", () => {
    expect(profile!.tokenizer.family).toBe("claude");
  });

  test("has cost.inUSDPerMtok=3", () => {
    expect(profile!.cost.inUSDPerMtok).toBe(3);
  });

  test("has cost.outUSDPerMtok=15", () => {
    expect(profile!.cost.outUSDPerMtok).toBe(15);
  });
});

// ── 2. profileFor with unknown id returns undefined ───────────────────────────

test("profileFor('unknown-model-xyz') returns undefined", () => {
  expect(profileFor("unknown-model-xyz")).toBeUndefined();
});

test("profileFor('') returns undefined", () => {
  expect(profileFor("")).toBeUndefined();
});

// ── 3. Every profile in PROFILES has required, valid fields ───────────────────

describe("every profile in PROFILES has valid required fields", () => {
  for (const p of PROFILES) {
    test(`profile '${p.id}': non-empty id`, () => {
      expect(typeof p.id).toBe("string");
      expect(p.id.length).toBeGreaterThan(0);
    });

    test(`profile '${p.id}': contextWindow > 0`, () => {
      expect(p.contextWindow).toBeGreaterThan(0);
    });

    test(`profile '${p.id}': maxOutput > 0`, () => {
      expect(p.maxOutput).toBeGreaterThan(0);
    });

    test(`profile '${p.id}': tokenizer.calibration > 0`, () => {
      expect(p.tokenizer.calibration).toBeGreaterThan(0);
    });

    test(`profile '${p.id}': cost.inUSDPerMtok > 0`, () => {
      expect(p.cost.inUSDPerMtok).toBeGreaterThan(0);
    });

    test(`profile '${p.id}': cost.outUSDPerMtok > 0`, () => {
      expect(p.cost.outUSDPerMtok).toBeGreaterThan(0);
    });

    test(`profile '${p.id}': non-empty strengths array`, () => {
      expect(Array.isArray(p.strengths)).toBe(true);
      expect(p.strengths.length).toBeGreaterThan(0);
    });

    test(`profile '${p.id}': non-empty weaknesses array`, () => {
      expect(Array.isArray(p.weaknesses)).toBe(true);
      expect(p.weaknesses.length).toBeGreaterThan(0);
    });

    test(`profile '${p.id}': asOf matches /^\\d{4}-\\d{2}$/`, () => {
      expect(p.asOf).toMatch(/^\d{4}-\d{2}$/);
    });
  }
});

// ── 4. All profile ids are unique ─────────────────────────────────────────────

test("all profile ids are unique", () => {
  const ids = PROFILES.map((p) => p.id);
  const uniqueIds = new Set(ids);
  expect(uniqueIds.size).toBe(ids.length);
});

// ── 5. PROVIDER_CALIBRATION has all expected keys with values > 0 ─────────────

describe("PROVIDER_CALIBRATION has all expected keys with values > 0", () => {
  const expectedKeys = ["anthropic", "openai", "google", "deepseek", "bedrock", "vertex"] as const;

  for (const key of expectedKeys) {
    test(`PROVIDER_CALIBRATION['${key}'] is defined and > 0`, () => {
      expect(PROVIDER_CALIBRATION[key]).toBeDefined();
      expect(PROVIDER_CALIBRATION[key]).toBeGreaterThan(0);
    });
  }
});

// ── 6. PROVIDER_CALIBRATION specific values ───────────────────────────────────

test("PROVIDER_CALIBRATION['anthropic'] is 1.35", () => {
  expect(PROVIDER_CALIBRATION["anthropic"]).toBe(1.35);
});

test("PROVIDER_CALIBRATION['openai'] is 1.0", () => {
  expect(PROVIDER_CALIBRATION["openai"]).toBe(1.0);
});

test("PROVIDER_CALIBRATION['google'] is 1.1", () => {
  expect(PROVIDER_CALIBRATION["google"]).toBe(1.1);
});

test("PROVIDER_CALIBRATION['deepseek'] is 1.05", () => {
  expect(PROVIDER_CALIBRATION["deepseek"]).toBe(1.05);
});

test("PROVIDER_CALIBRATION['bedrock'] is 1.35", () => {
  expect(PROVIDER_CALIBRATION["bedrock"]).toBe(1.35);
});

test("PROVIDER_CALIBRATION['vertex'] is 1.1", () => {
  expect(PROVIDER_CALIBRATION["vertex"]).toBe(1.1);
});

// ── 7. Bedrock Claude Sonnet carries a ~10% cost premium over Anthropic direct ─

test("bedrock Claude Sonnet cost.inUSDPerMtok is ~10% more than Anthropic direct (≈3.3 vs 3)", () => {
  const anthropicSonnet = profileFor("claude-sonnet-4-6");
  const bedrockSonnet = profileFor("bedrock/anthropic.claude-sonnet-4-20250514-v1:0");

  expect(anthropicSonnet).toBeDefined();
  expect(bedrockSonnet).toBeDefined();

  const direct = anthropicSonnet!.cost.inUSDPerMtok;   // 3
  const bedrock = bedrockSonnet!.cost.inUSDPerMtok;    // 3.3

  // The bedrock price should be approximately 10% higher
  expect(bedrock).toBeCloseTo(direct * 1.1, 5);
});

test("bedrock Claude Sonnet cost.outUSDPerMtok is ~10% more than Anthropic direct (≈16.5 vs 15)", () => {
  const anthropicSonnet = profileFor("claude-sonnet-4-6");
  const bedrockSonnet = profileFor("bedrock/anthropic.claude-sonnet-4-20250514-v1:0");

  expect(anthropicSonnet).toBeDefined();
  expect(bedrockSonnet).toBeDefined();

  const direct = anthropicSonnet!.cost.outUSDPerMtok;  // 15
  const bedrock = bedrockSonnet!.cost.outUSDPerMtok;   // 16.5

  expect(bedrock).toBeCloseTo(direct * 1.1, 5);
});

// ── 8. All anthropic/bedrock profiles use the 'claude' tokenizer family ────────

test("all profiles with provider=anthropic use tokenizer.family='claude'", () => {
  const anthropicProfiles = PROFILES.filter((p) => p.provider === "anthropic");
  expect(anthropicProfiles.length).toBeGreaterThan(0);
  for (const p of anthropicProfiles) {
    expect(p.tokenizer.family).toBe("claude");
  }
});

test("all profiles with provider=bedrock and a Claude model use tokenizer.family='claude'", () => {
  const bedrockClaudeProfiles = PROFILES.filter(
    (p) => p.provider === "bedrock" && p.id.includes("anthropic.claude"),
  );
  expect(bedrockClaudeProfiles.length).toBeGreaterThan(0);
  for (const p of bedrockClaudeProfiles) {
    expect(p.tokenizer.family).toBe("claude");
  }
});

// Broader check: every bedrock profile that has tokenizer calibration 1.35 uses 'claude' family
test("all bedrock profiles with Claude tokenizer calibration (1.35) use tokenizer.family='claude'", () => {
  const bedrockProfiles = PROFILES.filter((p) => p.provider === "bedrock");
  expect(bedrockProfiles.length).toBeGreaterThan(0);
  for (const p of bedrockProfiles) {
    if (p.tokenizer.calibration === 1.35) {
      expect(p.tokenizer.family).toBe("claude");
    }
  }
});

// ── Spot-checks for a few other known profiles ────────────────────────────────

test("profileFor('claude-opus-4-8') has correct fields", () => {
  const p = profileFor("claude-opus-4-8");
  expect(p).toBeDefined();
  expect(p!.provider).toBe("anthropic");
  expect(p!.contextWindow).toBe(1_000_000);
  expect(p!.maxOutput).toBe(128_000);
  expect(p!.tokenizer.calibration).toBe(1.35);
  expect(p!.cost.inUSDPerMtok).toBe(5);
});

test("profileFor('claude-haiku-4-5') has correct fields", () => {
  const p = profileFor("claude-haiku-4-5");
  expect(p).toBeDefined();
  expect(p!.provider).toBe("anthropic");
  expect(p!.contextWindow).toBe(200_000);
  expect(p!.maxOutput).toBe(32_000);
  expect(p!.tokenizer.calibration).toBe(1.35);
  expect(p!.cost.inUSDPerMtok).toBe(1);
});

test("profileFor('gpt-5.5') has provider=openai and calibration=1.0", () => {
  const p = profileFor("gpt-5.5");
  expect(p).toBeDefined();
  expect(p!.provider).toBe("openai");
  expect(p!.tokenizer.calibration).toBe(1.0);
  expect(p!.cost.inUSDPerMtok).toBe(2.5);
});

test("profileFor('gemini-3.5-flash') has provider=google and calibration=1.1", () => {
  const p = profileFor("gemini-3.5-flash");
  expect(p).toBeDefined();
  expect(p!.provider).toBe("google");
  expect(p!.tokenizer.calibration).toBe(1.1);
  expect(p!.cost.inUSDPerMtok).toBe(0.3);
});

test("profileFor('deepseek-v4-pro') has provider=deepseek and calibration=1.05", () => {
  const p = profileFor("deepseek-v4-pro");
  expect(p).toBeDefined();
  expect(p!.provider).toBe("deepseek");
  expect(p!.tokenizer.calibration).toBe(1.05);
});

test("profileFor('bedrock/anthropic.claude-sonnet-4-20250514-v1:0') has provider=bedrock and calibration=1.35", () => {
  const p = profileFor("bedrock/anthropic.claude-sonnet-4-20250514-v1:0");
  expect(p).toBeDefined();
  expect(p!.provider).toBe("bedrock");
  expect(p!.tokenizer.calibration).toBe(1.35);
});

// ── PROFILES array sanity ─────────────────────────────────────────────────────

test("PROFILES is a non-empty array", () => {
  expect(Array.isArray(PROFILES)).toBe(true);
  expect(PROFILES.length).toBeGreaterThan(0);
});

test("profileFor returns the same object that appears in PROFILES", () => {
  for (const p of PROFILES) {
    expect(profileFor(p.id)).toBe(p);
  }
});

// ── outputFactorFor ────────────────────────────────────────────────────────────

describe("outputFactorFor", () => {
  test("defaults to 0.2 for a plain model with no override (haiku)", () => {
    expect(outputFactorFor("claude-haiku-4-5")).toBe(OUTPUT_FACTOR_DEFAULT);
    expect(OUTPUT_FACTOR_DEFAULT).toBe(0.2);
  });

  test("defaults to 0.2 for an unknown model id", () => {
    expect(outputFactorFor("unknown-model-xyz")).toBe(0.2);
  });

  test("reasoning-heavy models carry higher factors", () => {
    expect(outputFactorFor("claude-opus-4-8")).toBe(0.5);
    expect(outputFactorFor("claude-sonnet-4-6")).toBe(0.35);
    expect(outputFactorFor("gpt-5.5")).toBe(0.5);
    expect(outputFactorFor("gemini-3.1-pro-preview")).toBe(0.4);
    expect(outputFactorFor("deepseek-v4-pro")).toBe(0.6);
  });

  test("bedrock/vertex mirrors match their direct-provider entries", () => {
    expect(outputFactorFor("bedrock/anthropic.claude-opus-4-20250514-v1:0")).toBe(outputFactorFor("claude-opus-4-8"));
    expect(outputFactorFor("vertex/gemini-3.1-pro-preview")).toBe(outputFactorFor("gemini-3.1-pro-preview"));
  });

  test("every override in the corpus is a sane fraction (0 < f <= 1)", () => {
    for (const p of PROFILES) {
      if (p.outputFactor !== undefined) {
        expect(p.outputFactor).toBeGreaterThan(0);
        expect(p.outputFactor).toBeLessThanOrEqual(1);
      }
    }
  });
});

// ── cacheReadDiscount ──────────────────────────────────────────────────────────

describe("cacheReadDiscount", () => {
  test("known providers return the researched discount fractions", () => {
    expect(cacheReadDiscount("anthropic")).toBe(0.1);
    expect(cacheReadDiscount("openai")).toBe(0.1);
    expect(cacheReadDiscount("deepseek")).toBe(0.1);
    expect(cacheReadDiscount("google")).toBe(0.25);
    expect(cacheReadDiscount("vertex")).toBe(0.25);
    expect(cacheReadDiscount("bedrock")).toBe(0.1);
  });

  test("unknown provider returns null (scorer treats as no-cache)", () => {
    expect(cacheReadDiscount("not-a-provider")).toBeNull();
    expect(cacheReadDiscount("")).toBeNull();
  });

  test("every known discount is a fraction strictly between 0 and 1", () => {
    for (const provider of ["anthropic", "openai", "deepseek", "google", "vertex", "bedrock"]) {
      const d = cacheReadDiscount(provider)!;
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThan(1);
    }
  });
});
