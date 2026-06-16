import { test, expect, describe } from "bun:test";
import { contractFor } from "../src/model/contract.ts";

// Per-provider documented defaults — asserts the registry matches each
// provider's docs for the contract fields that break a first call: token-param
// name, temperature range, system-role. Sourced from the June-2026 research
// (citations in src/model/contract.ts PROVIDER_DEFAULTS + design doc).

describe("token param matches docs per provider", () => {
  const maxCompletion = ["minimax", "xai", "groq", "cerebras", "nebius", "vllm"];
  const maxTokens = [
    "deepseek", "moonshot", "zai", "mistral", "perplexity", "openrouter",
    "vercel-gateway", "portkey", "requesty", "litellm", "fireworks", "together",
    "deepinfra", "baseten", "hyperbolic", "novita", "sambanova", "ollama",
    "lmstudio", "llamacpp",
  ];
  test("max_completion_tokens providers", () => {
    for (const p of maxCompletion) {
      expect([contractFor(p, "some-generic-model").tokenParam, p]).toEqual(["max_completion_tokens", p]);
    }
  });
  test("max_tokens providers", () => {
    for (const p of maxTokens) {
      expect([contractFor(p, "some-generic-model").tokenParam, p]).toEqual(["max_tokens", p]);
    }
  });
});

describe("temperature clamp matches docs", () => {
  test("0-1 range: moonshot, zai, together", () => {
    for (const p of ["moonshot", "zai", "together"]) {
      expect([contractFor(p, "x").tempClamp, p]).toEqual([[0, 1], p]);
    }
  });
  test("0-0.7: mistral", () => {
    expect(contractFor("mistral", "mistral-small").tempClamp).toEqual([0, 0.7]);
  });
  test("0-2 range: deepseek, xai, groq, cerebras, perplexity, fireworks, deepinfra, nebius, novita, sambanova, minimax", () => {
    for (const p of ["deepseek", "xai", "groq", "cerebras", "perplexity", "fireworks", "deepinfra", "nebius", "novita", "sambanova", "minimax"]) {
      expect([contractFor(p, "x").tempClamp, p]).toEqual([[0, 2], p]);
    }
  });
  test("no clamp on openai/azure/gateways", () => {
    for (const p of ["openai", "azure", "openrouter", "portkey", "litellm"]) {
      expect([contractFor(p, "gpt-4o").tempClamp, p]).toEqual([undefined, p]);
    }
  });
});

describe("provider-native reasoning shapes match docs", () => {
  test("thinking-toggle: deepseek-v4, kimi-k2.6, glm, minimax", () => {
    expect(contractFor("deepseek", "deepseek-v4-pro").reasoning.shape).toBe("thinking-toggle");
    expect(contractFor("moonshot", "kimi-k2.6").reasoning.shape).toBe("thinking-toggle");
    expect(contractFor("zai", "glm-4.6").reasoning.shape).toBe("thinking-toggle");
    expect(contractFor("minimax", "minimax-m3").reasoning.shape).toBe("thinking-toggle");
  });
  test("always-on: kimi-k2.7-code (temperature dropped, temp clamp 0-1)", () => {
    const c = contractFor("moonshot", "kimi-k2.7-code");
    expect(c.reasoning.shape).toBe("always-on");
    expect(c.dropParams).toContain("temperature");
    expect(c.tempClamp).toEqual([0, 1]);
  });
  test("think-tag: mistral magistral, perplexity sonar-reasoning, hosted Qwen3", () => {
    expect(contractFor("mistral", "magistral-medium-2509").reasoning.outputField).toBe("think-tag");
    expect(contractFor("perplexity", "sonar-reasoning-pro").reasoning.shape).toBe("think-tag");
    expect(contractFor("hyperbolic", "Qwen/Qwen3-235B").reasoning.shape).toBe("think-tag");
    expect(contractFor("sambanova", "qwen3-32b").reasoning.shape).toBe("think-tag");
  });
  test("hosted/native R1 is always-on (enable-less); native emits reasoning_content", () => {
    expect(contractFor("deepseek", "deepseek-r1").reasoning.shape).toBe("always-on");
    expect(contractFor("hyperbolic", "deepseek-ai/DeepSeek-R1").reasoning.shape).toBe("always-on");
  });
  test("grok variant-id vs effort vs code-fast", () => {
    expect(contractFor("xai", "grok-4-fast-reasoning").reasoning.shape).toBe("variant-id");
    expect(contractFor("xai", "grok-4.3").reasoning.shape).toBe("openai-effort");
    expect(contractFor("xai", "grok-code-fast-1").tempClamp).toEqual([0, 1]);
  });
});

describe("provider quirks: dropped params match docs", () => {
  test("perplexity sonar-reasoning drops tools (unsupported on Sonar chat)", () => {
    expect(contractFor("perplexity", "sonar-reasoning-pro").dropParams).toContain("tools");
  });
  test("groq gpt-oss drops logprobs/logit_bias/n", () => {
    const c = contractFor("groq", "openai/gpt-oss-120b");
    expect(c.dropParams).toContain("logprobs");
    expect(c.dropParams).toContain("n");
  });
  test("mistral magistral drops penalties + n (strict 422)", () => {
    const c = contractFor("mistral", "magistral-small-2509");
    expect(c.dropParams).toContain("presence_penalty");
    expect(c.dropParams).toContain("n");
  });
});

describe("system role matches docs", () => {
  test("everything OpenAI-compat takes system; OpenAI reasoning aliases developer", () => {
    for (const p of ["deepseek", "moonshot", "zai", "groq", "cerebras", "together", "fireworks"]) {
      expect([contractFor(p, "generic").systemRole, p]).toEqual(["system", p]);
    }
    expect(contractFor("openai", "o3").systemRole).toBe("developer");
  });
});
