import { test, expect, describe } from "bun:test";
import { contractFor } from "../src/model/contract.ts";
import { effortLevels, reasoningOptions } from "../src/model/reasoning.ts";
import { estimateCost, type ModelSpec } from "../src/providers.ts";

function spec(p: Partial<ModelSpec> & Pick<ModelSpec, "provider" | "sdkId">): ModelSpec {
  return { id: p.sdkId, label: p.sdkId, contextWindow: 128_000, ...p } as ModelSpec;
}

describe("#11 — effort is only OFFERED for shapes the wire can emit", () => {
  test("provider-native toggle families show no effort knob (displayed == emitted == none)", () => {
    // deepseek-v4 (thinking-toggle) and magistral (variant-id) reason, but the AI
    // SDK carries no param for them → reasoningOptions returns {} → so the picker
    // must not offer a level (it would skew the flywheel's per-effort prior).
    const dv4 = spec({ provider: "deepseek", sdkId: "deepseek-v4-pro", reasoning: true });
    expect(effortLevels(dv4)).toEqual([]);
    expect(reasoningOptions(dv4, "high")).toEqual({});

    const mag = spec({ provider: "mistral", sdkId: "magistral-medium-2509", reasoning: true });
    expect(effortLevels(mag)).toEqual([]);
    expect(reasoningOptions(mag, "high")).toEqual({});
  });
  test("emittable shapes still offer their vocab", () => {
    expect(effortLevels(spec({ provider: "azure-foundry", sdkId: "o3", reasoning: true }))).toEqual(["low", "medium", "high"]);
  });
});

describe("#9 — Cohere command-r1 is not an R1 reasoner", () => {
  test("command-r1 on a host no longer matches the R1/think-tag rule", () => {
    expect(contractFor("together", "command-r1").reasoning.shape).toBe("none");
    // real deepseek R1 + distills still classify (via the global anchored rule)
    expect(contractFor("together", "deepseek-ai/DeepSeek-R1").reasoning.shape).toBe("always-on");
    expect(contractFor("together", "deepseek-r1-distill-llama-70b").reasoning.shape).toBe("always-on");
  });
});

describe("#16 — groq anchoring (documented intentional behavior)", () => {
  test("no-boundary substring does not match; hyphen-delimited token does (intentional)", () => {
    expect(contractFor("groq", "myqwen3model").reasoning.shape).toBe("none");
    // a delimited gpt-oss token IS treated as gpt-oss — deliberate (see comment)
    expect(contractFor("groq", "my-gpt-oss-clone").reasoning.shape).toBe("openai-effort");
    // and qwq mid-segment (the real qwen-qwq-32b id) must still classify
    expect(contractFor("groq", "qwen-qwq-32b").reasoning.shape).toBe("openai-effort");
  });
});

describe("#8 — cachedIn and perRequestUSD are now consumed by estimateCost", () => {
  test("cachedIn drives the cache-read term (not the flat 0.1x)", () => {
    // gpt-4o: in $2.5, cachedIn $1.25 — flat 0.1x would be $0.25, the published
    // rate is $1.25. 1M cached input tokens must cost the published rate.
    const usd = estimateCost([{ model: "gpt-4o", inputTokens: 0, outputTokens: 0, cachedInputTokens: 1_000_000 }]);
    expect(usd).toBeCloseTo(1.25, 5);
  });
  test("perRequestUSD (Sonar search fee) is added per turn", () => {
    // sonar: $1/$1 tokens + $0.008/request. Zero tokens → just the request fee.
    const usd = estimateCost([{ model: "sonar", inputTokens: 0, outputTokens: 0 }]);
    expect(usd).toBeCloseTo(0.008, 5);
  });
});
