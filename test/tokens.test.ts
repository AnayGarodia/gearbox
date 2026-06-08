import { test, expect, describe } from "bun:test";
import { baseTokens, countTokens, countTokensForProvider } from "../src/model/tokens.ts";

// ── Shared fixtures ──────────────────────────────────────────────────────────
const SHORT_PHRASE = "Hello, world!";
const LONGER_TEXT = "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.";
const EMPTY = "";

// ── 1. baseTokens ────────────────────────────────────────────────────────────
describe("baseTokens", () => {
  test("returns 0 for an empty string", () => {
    expect(baseTokens(EMPTY)).toBe(0);
  });

  test("returns a positive integer for a short phrase", () => {
    const count = baseTokens(SHORT_PHRASE);
    expect(count).toBeGreaterThan(0);
    expect(Number.isInteger(count)).toBe(true);
  });

  test("returns a positive integer for longer text", () => {
    const count = baseTokens(LONGER_TEXT);
    expect(count).toBeGreaterThan(0);
    expect(Number.isInteger(count)).toBe(true);
  });

  test("longer text produces more tokens than a short phrase", () => {
    expect(baseTokens(LONGER_TEXT)).toBeGreaterThan(baseTokens(SHORT_PHRASE));
  });
});

// ── 2. countTokens — no modelId → DEFAULT_CALIBRATION = 1.35 ────────────────
describe("countTokens with no modelId (DEFAULT_CALIBRATION = 1.35)", () => {
  test("result equals Math.ceil(baseTokens * 1.35) for a short phrase", () => {
    const base = baseTokens(SHORT_PHRASE);
    expect(countTokens(SHORT_PHRASE)).toBe(Math.ceil(base * 1.35));
  });

  test("result equals Math.ceil(baseTokens * 1.35) for longer text", () => {
    const base = baseTokens(LONGER_TEXT);
    expect(countTokens(LONGER_TEXT)).toBe(Math.ceil(base * 1.35));
  });

  test("result is 0 for empty string", () => {
    expect(countTokens(EMPTY)).toBe(0);
  });
});

// ── 3. countTokens — known model id with calibration 1.0 (gpt-5.5) ──────────
describe("countTokens with known model 'gpt-5.5' (calibration = 1.0)", () => {
  test("result equals baseTokens (Math.ceil(base * 1.0)) for a short phrase", () => {
    const base = baseTokens(SHORT_PHRASE);
    expect(countTokens(SHORT_PHRASE, "gpt-5.5")).toBe(Math.ceil(base * 1.0));
    expect(countTokens(SHORT_PHRASE, "gpt-5.5")).toBe(base);
  });

  test("result equals baseTokens for longer text", () => {
    const base = baseTokens(LONGER_TEXT);
    expect(countTokens(LONGER_TEXT, "gpt-5.5")).toBe(base);
  });
});

// ── 4. countTokens — unknown model id falls back to DEFAULT_CALIBRATION 1.35 ─
describe("countTokens with an unknown modelId (fallback to 1.35)", () => {
  test("unknown model id produces same result as no model id", () => {
    const withoutModel = countTokens(SHORT_PHRASE);
    const withUnknown = countTokens(SHORT_PHRASE, "totally-unknown-model-xyz");
    expect(withUnknown).toBe(withoutModel);
  });

  test("unknown model id equals Math.ceil(baseTokens * 1.35)", () => {
    const base = baseTokens(LONGER_TEXT);
    expect(countTokens(LONGER_TEXT, "totally-unknown-model-xyz")).toBe(Math.ceil(base * 1.35));
  });
});

// ── 5. countTokensForProvider — anthropic (calibration = 1.35) ───────────────
describe("countTokensForProvider('anthropic') — calibration 1.35", () => {
  test("result equals Math.ceil(baseTokens * 1.35) for a short phrase", () => {
    const base = baseTokens(SHORT_PHRASE);
    expect(countTokensForProvider(SHORT_PHRASE, "anthropic")).toBe(Math.ceil(base * 1.35));
  });

  test("result equals Math.ceil(baseTokens * 1.35) for longer text", () => {
    const base = baseTokens(LONGER_TEXT);
    expect(countTokensForProvider(LONGER_TEXT, "anthropic")).toBe(Math.ceil(base * 1.35));
  });

  test("matches countTokens with no model id (both use 1.35)", () => {
    expect(countTokensForProvider(SHORT_PHRASE, "anthropic")).toBe(countTokens(SHORT_PHRASE));
  });
});

// ── 6. countTokensForProvider — openai (calibration = 1.0) ───────────────────
describe("countTokensForProvider('openai') — calibration 1.0", () => {
  test("result equals baseTokens for a short phrase", () => {
    const base = baseTokens(SHORT_PHRASE);
    expect(countTokensForProvider(SHORT_PHRASE, "openai")).toBe(Math.ceil(base * 1.0));
    expect(countTokensForProvider(SHORT_PHRASE, "openai")).toBe(base);
  });

  test("result equals baseTokens for longer text", () => {
    const base = baseTokens(LONGER_TEXT);
    expect(countTokensForProvider(LONGER_TEXT, "openai")).toBe(base);
  });

  test("matches countTokens with gpt-5.5 (both use calibration 1.0)", () => {
    expect(countTokensForProvider(SHORT_PHRASE, "openai")).toBe(countTokens(SHORT_PHRASE, "gpt-5.5"));
  });
});

// ── 7. countTokensForProvider — google (calibration = 1.1) ───────────────────
describe("countTokensForProvider('google') — calibration 1.1", () => {
  test("result equals Math.ceil(baseTokens * 1.1) for a short phrase", () => {
    const base = baseTokens(SHORT_PHRASE);
    expect(countTokensForProvider(SHORT_PHRASE, "google")).toBe(Math.ceil(base * 1.1));
  });

  test("result equals Math.ceil(baseTokens * 1.1) for longer text", () => {
    const base = baseTokens(LONGER_TEXT);
    expect(countTokensForProvider(LONGER_TEXT, "google")).toBe(Math.ceil(base * 1.1));
  });
});

// ── 8. Calibrated count >= baseTokens when calibration >= 1 ──────────────────
describe("calibrated counts are always >= baseTokens when calibration >= 1", () => {
  for (const text of [SHORT_PHRASE, LONGER_TEXT]) {
    test(`countTokens (no model, cal=1.35) >= baseTokens for "${text.slice(0, 20)}..."`, () => {
      expect(countTokens(text)).toBeGreaterThanOrEqual(baseTokens(text));
    });

    test(`countTokens (gpt-5.5, cal=1.0) >= baseTokens for "${text.slice(0, 20)}..."`, () => {
      expect(countTokens(text, "gpt-5.5")).toBeGreaterThanOrEqual(baseTokens(text));
    });

    test(`countTokensForProvider anthropic >= baseTokens for "${text.slice(0, 20)}..."`, () => {
      expect(countTokensForProvider(text, "anthropic")).toBeGreaterThanOrEqual(baseTokens(text));
    });

    test(`countTokensForProvider openai >= baseTokens for "${text.slice(0, 20)}..."`, () => {
      expect(countTokensForProvider(text, "openai")).toBeGreaterThanOrEqual(baseTokens(text));
    });

    test(`countTokensForProvider google >= baseTokens for "${text.slice(0, 20)}..."`, () => {
      expect(countTokensForProvider(text, "google")).toBeGreaterThanOrEqual(baseTokens(text));
    });

    test(`countTokensForProvider deepseek >= baseTokens for "${text.slice(0, 20)}..."`, () => {
      expect(countTokensForProvider(text, "deepseek")).toBeGreaterThanOrEqual(baseTokens(text));
    });

    test(`countTokensForProvider bedrock >= baseTokens for "${text.slice(0, 20)}..."`, () => {
      expect(countTokensForProvider(text, "bedrock")).toBeGreaterThanOrEqual(baseTokens(text));
    });

    test(`countTokensForProvider vertex >= baseTokens for "${text.slice(0, 20)}..."`, () => {
      expect(countTokensForProvider(text, "vertex")).toBeGreaterThanOrEqual(baseTokens(text));
    });
  }
});

// ── 9. Results are always integers ───────────────────────────────────────────
describe("all sync token counts are integers", () => {
  test("baseTokens returns an integer", () => {
    expect(Number.isInteger(baseTokens(SHORT_PHRASE))).toBe(true);
    expect(Number.isInteger(baseTokens(LONGER_TEXT))).toBe(true);
  });

  test("countTokens (no model) returns an integer", () => {
    expect(Number.isInteger(countTokens(SHORT_PHRASE))).toBe(true);
    expect(Number.isInteger(countTokens(LONGER_TEXT))).toBe(true);
  });

  test("countTokens (gpt-5.5, cal=1.0) returns an integer", () => {
    expect(Number.isInteger(countTokens(SHORT_PHRASE, "gpt-5.5"))).toBe(true);
  });

  test("countTokens (claude-sonnet-4-6, cal=1.35) returns an integer", () => {
    expect(Number.isInteger(countTokens(SHORT_PHRASE, "claude-sonnet-4-6"))).toBe(true);
  });

  test("countTokens (claude-haiku-4-5, cal=1.35) returns an integer", () => {
    expect(Number.isInteger(countTokens(SHORT_PHRASE, "claude-haiku-4-5"))).toBe(true);
  });

  test("countTokens (unknown model, fallback) returns an integer", () => {
    expect(Number.isInteger(countTokens(SHORT_PHRASE, "unknown-model"))).toBe(true);
  });

  test("countTokensForProvider returns integers for all providers", () => {
    const providers = ["anthropic", "openai", "google", "deepseek", "bedrock", "vertex"] as const;
    for (const p of providers) {
      expect(Number.isInteger(countTokensForProvider(SHORT_PHRASE, p))).toBe(true);
      expect(Number.isInteger(countTokensForProvider(LONGER_TEXT, p))).toBe(true);
    }
  });
});

// ── Bonus: known-model calibration cross-check ───────────────────────────────
describe("known model calibrations cross-check", () => {
  test("claude-sonnet-4-6 (cal=1.35) matches anthropic provider calibration", () => {
    expect(countTokens(SHORT_PHRASE, "claude-sonnet-4-6")).toBe(
      countTokensForProvider(SHORT_PHRASE, "anthropic"),
    );
  });

  test("claude-haiku-4-5 (cal=1.35) matches anthropic provider calibration", () => {
    expect(countTokens(SHORT_PHRASE, "claude-haiku-4-5")).toBe(
      countTokensForProvider(SHORT_PHRASE, "anthropic"),
    );
  });

  test("gpt-5.5 (cal=1.0) matches openai provider calibration", () => {
    expect(countTokens(SHORT_PHRASE, "gpt-5.5")).toBe(
      countTokensForProvider(SHORT_PHRASE, "openai"),
    );
  });
});
