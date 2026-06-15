import { test, expect, describe } from "bun:test";
import { contractFor, isResponsesOnly, OPENAI_REASONING_DROP } from "../src/model/contract.ts";

describe("contractFor — API surface (the codex/responses fix)", () => {
  test("codex families on every OpenAI-surface provider are responses-only", () => {
    for (const p of ["openai", "azure", "azure-foundry"] as const) {
      expect(contractFor(p, "gpt-5.3-codex").surface).toBe("responses");
      expect(contractFor(p, "gpt-5-codex").surface).toBe("responses");
      expect(contractFor(p, "codex-mini").surface).toBe("responses");
      expect(isResponsesOnly(p, "gpt-5.1-codex-max")).toBe(true);
    }
  });

  test("an arbitrary Azure deployment name resolved to a codex family is responses-only", () => {
    // resolveModel passes canonicalId; a deployment literally named "my-coder"
    // would carry canonicalId "gpt-5.3-codex".
    expect(isResponsesOnly("azure-foundry", "gpt-5.3-codex")).toBe(true);
  });

  test("*-pro families are responses-only with effort forced high", () => {
    const pro = contractFor("openai", "gpt-5.4-pro");
    expect(pro.surface).toBe("responses");
    expect(pro.reasoning.force).toBe("high");
    expect(contractFor("openai", "o3-pro").surface).toBe("responses");
    expect(contractFor("openai", "o3-pro").noStream).toBe(true);
  });

  test("base codex cannot stream; codex-mini can", () => {
    expect(contractFor("openai", "gpt-5-codex").noStream).toBe(true);
    expect(contractFor("openai", "codex-mini").noStream).toBeUndefined();
  });

  test("regular chat models stay on chat completions", () => {
    expect(contractFor("openai", "gpt-5.5").surface).toBe("chat");
    expect(contractFor("azure-foundry", "DeepSeek-V4-Pro").surface).toBe("chat");
    expect(contractFor("openai", "gpt-4o").surface).toBe("chat");
  });
});

describe("contractFor — token param & dropped params", () => {
  test("reasoning models on chat use max_completion_tokens and drop the 8 sampling params", () => {
    const c = contractFor("openai", "o3");
    expect(c.tokenParam).toBe("max_completion_tokens");
    expect(c.dropParams).toEqual(OPENAI_REASONING_DROP);
  });

  test("responses-only models use max_output_tokens", () => {
    expect(contractFor("openai", "gpt-5.3-codex").tokenParam).toBe("max_output_tokens");
  });

  test("non-reasoning OpenAI models use max_tokens and drop nothing", () => {
    const c = contractFor("openai", "gpt-4o");
    expect(c.tokenParam).toBe("max_tokens");
    expect(c.dropParams).toEqual([]);
  });

  test("gpt-5 base allows minimal effort; 5.1+ does not", () => {
    expect(contractFor("openai", "gpt-5").reasoning.vocab).toContain("minimal");
    expect(contractFor("openai", "gpt-5.5").reasoning.vocab).not.toContain("minimal");
  });
});

describe("contractFor — system role", () => {
  test("OpenAI reasoning families alias system→developer; o1-mini outright developer", () => {
    expect(contractFor("openai", "o3").systemRole).toBe("developer");
    expect(contractFor("openai", "o1-mini").systemRole).toBe("developer");
    expect(contractFor("openai", "gpt-4o").systemRole).toBe("system");
  });
});

describe("contractFor — per-provider defaults (the OpenAI-compat crowd)", () => {
  test("unknown model on a compat provider gets the safe chat/system/max_tokens baseline", () => {
    const c = contractFor("deepseek", "deepseek-v4-pro");
    expect(c.surface).toBe("chat");
    expect(c.systemRole).toBe("system");
    expect(c.src).toBe("default"); // deepseek-v4-pro matches no family rule → provider default
  });

  test("temperature clamps: moonshot/zai 0-1, mistral 0-0.7", () => {
    expect(contractFor("moonshot", "kimi-k2.6").tempClamp).toEqual([0, 1]);
    expect(contractFor("zai", "glm-4.6").tempClamp).toEqual([0, 1]);
    expect(contractFor("mistral", "mistral-large-3").tempClamp).toEqual([0, 0.7]);
  });

  test("max_completion_tokens providers: xai, groq, cerebras", () => {
    expect(contractFor("groq", "llama-3.3-70b-versatile").tokenParam).toBe("max_completion_tokens");
    expect(contractFor("cerebras", "gpt-oss-120b").tokenParam).toBe("max_completion_tokens");
  });
});

describe("contractFor — reasoning shapes", () => {
  test("R1-class reasoners are always-on and surface reasoning_content", () => {
    const c = contractFor("deepseek", "deepseek-r1");
    expect(c.reasoning.shape).toBe("always-on");
    expect(c.reasoning.outputField).toBe("reasoning_content");
  });

  test("Anthropic uses thinking shape; Gemini uses google-thinking", () => {
    expect(contractFor("anthropic", "claude-opus-4-8").reasoning.shape).toBe("anthropic-thinking");
    expect(contractFor("vertex", "gemini-3-pro-preview").reasoning.shape).toBe("google-thinking");
  });

  test("grok reasoning-variant ids are variant-id; grok-4.3 takes effort", () => {
    expect(contractFor("xai", "grok-4-fast-reasoning").reasoning.shape).toBe("variant-id");
    expect(contractFor("xai", "grok-4.3").reasoning.shape).toBe("openai-effort");
  });
});
