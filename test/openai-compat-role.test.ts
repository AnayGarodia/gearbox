import { test, expect } from "bun:test";
import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { resolveModel } from "../src/providers.ts";
import type { ModelSpec } from "../src/providers.ts";

// Regression: @ai-sdk/openai sends the system prompt as role:"developer" for any
// model id it doesn't recognise as gpt-3/4 (it assumes a reasoning model). Azure
// AI Foundry's grok/deepseek/kimi deployments reject that with a 422 enum error
// on messages[0].role. The OpenAI-wire path must use @ai-sdk/openai-compatible,
// which always sends role:"system".
test("openai-compatible sends the system prompt as role 'system' (not 'developer')", async () => {
  let captured: any = null;
  const fakeFetch = (async (_url: string, init: any) => {
    captured = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        id: "x", object: "chat.completion", created: 0, model: "grok-4.3",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const model = createOpenAICompatible({ name: "azure-foundry", baseURL: "https://example/openai/v1", apiKey: "x", fetch: fakeFetch })("grok-4.3");
  await generateText({ model, system: "You are a helpful agent.", prompt: "hi" });

  expect(captured).not.toBeNull();
  expect(captured.messages[0].role).toBe("system");
  expect(captured.messages.some((m: any) => m.role === "developer")).toBe(false);
});

test("resolveModel routes a baseURL provider through openai-compatible, not openai", () => {
  const spec: ModelSpec = { id: "azure-foundry/grok-4.3", provider: "azure-foundry", sdkId: "grok-4.3", label: "grok-4.3", contextWindow: 128_000, capabilities: { source: "api-discovered" } };
  const model: any = resolveModel(spec, { baseURL: "https://example/openai/v1", apiKey: "x" } as any);
  // openai-compatible names the model "<provider>.chat"; the old @ai-sdk/openai
  // path named it "openai.chat".
  expect(model.provider).toBe("azure-foundry.chat");
});
