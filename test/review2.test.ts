import { test, expect, describe } from "bun:test";
import { contractFor } from "../src/model/contract.ts";
import { priceFor } from "../src/model/pricing.ts";
import { classifyError } from "../src/model/error-taxonomy.ts";

// Locks the second deep-review round (#5–#21).

describe("contract family-rule reach (#5/#6/#7/#8/#16/#17/#18)", () => {
  test("#5 bare-codex rule no longer over-reaches arbitrary deployments", () => {
    // a deployment merely containing "codex" must NOT be forced to responses
    expect(contractFor("azure-foundry", "my-codex-deploy").surface).toBe("chat");
    expect(contractFor("azure-foundry", "codex-next").surface).toBe("chat");
    // the real families still resolve responses
    expect(contractFor("openai", "gpt-5-codex").surface).toBe("responses");
    expect(contractFor("openai", "codex").surface).toBe("responses");
  });

  test("#7 o1-pro is Responses-only (was mis-caught by the broad o1 rule → chat)", () => {
    expect(contractFor("openai", "o1-pro").surface).toBe("responses");
    expect(contractFor("openai", "o1-pro").reasoning.force).toBe("high");
    expect(contractFor("openai", "o1").surface).toBe("chat"); // plain o1 unchanged
  });

  test("#8 Groq QwQ (qwen-qwq-32b) is recognised as a reasoner", () => {
    const c = contractFor("groq", "qwen-qwq-32b");
    expect(c.reasoning.shape).toBe("openai-effort");
  });

  test("#16 Groq rule is anchored — no bare-substring matches (no token boundary)", () => {
    // qwen3 buried inside a word with no boundary must NOT match (the N9/#16 bug)
    expect(contractFor("groq", "myqwen3model").reasoning.shape).toBe("none");
    expect(contractFor("groq", "foogptossbar").reasoning.shape).toBe("none");
    // a real boundary-delimited token still matches (legit gpt-oss deployment)
    expect(contractFor("groq", "openai/gpt-oss-120b").reasoning.shape).toBe("openai-effort");
  });

  test("#17 kimi-k2.7 / future k2.8 base lines are thinking-toggle, not none", () => {
    expect(contractFor("moonshot", "kimi-k2.7").reasoning.shape).toBe("thinking-toggle");
    expect(contractFor("moonshot", "kimi-k2.8").reasoning.shape).toBe("thinking-toggle");
    expect(contractFor("moonshot", "kimi-k2.7-code").reasoning.shape).toBe("always-on");
  });

  test("#18 a Groq-served deepseek-r1 inherits Groq's token param, not max_tokens", () => {
    const c = contractFor("groq", "deepseek-r1-distill-llama-70b");
    expect(c.reasoning.shape).toBe("always-on"); // R1 rule contributes reasoning
    expect(c.tokenParam).toBe("max_completion_tokens"); // ...but inherits Groq's baseline
  });
});

describe("pricing containment guard (#12/#19)", () => {
  test("#12 a -lite variant does not inherit the -flash base price", () => {
    // gemini-2.5-flash is in GENERIC; -flash-lite must NOT inherit it
    expect(priceFor("google", "gemini-2.5-flash-lite")).toBeUndefined();
  });
  test("#12 an R1 distill does not inherit the deepseek-r1 base price", () => {
    expect(priceFor("deepinfra", "deepseek-ai/DeepSeek-R1-Distill-Llama-70B")).toBeUndefined();
  });
  test("#19 gpt-5.5-codex does not inherit the gpt-5.5 chat price", () => {
    // gpt-5.5 is curated, not in GENERIC; canonical match is guarded by codex in
    // TIER_MODIFIER (tested via the contract/pricing tier guards) — here we assert
    // the table itself refuses the codex remainder.
    expect(priceFor("openai", "gpt-5.5-codex")).toBeUndefined();
  });
});

describe("error-taxonomy hardening (#13/#14/#20)", () => {
  test("#13 'load balancer' in an Anthropic 400 is NOT a quota/account park", () => {
    const c = classifyError({ type: "error", error: { type: "invalid_request_error", message: "tool call to load balancer failed" } });
    expect(c.class).toBe("bad-request");
    expect(c.scope).toBe("model"); // not account
  });
  test("#13 a genuine credit-balance message still classifies quota", () => {
    expect(classifyError({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low" } }).class).toBe("quota");
  });
  test("#14 a cyclic error object does not crash the classifier", () => {
    const cyclic: any = { statusCode: 429, message: "rate limit" };
    cyclic.cause = cyclic; // cyclic reference, JSON.stringify would throw
    expect(() => classifyError(cyclic)).not.toThrow();
    expect(classifyError(cyclic).class).toBe("rate-limit");
  });
  test("#20 network/transport failures classify as server (retry, no hop)", () => {
    expect(classifyError("fetch failed: ECONNRESET").class).toBe("server");
    expect(classifyError({ message: "getaddrinfo ENOTFOUND api.x" }).class).toBe("server");
    expect(classifyError("fetch failed").kind).toBe("other"); // not a failover hop
  });
});
