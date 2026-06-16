import { test, expect, describe } from "bun:test";
import { classifyError } from "../src/model/error-taxonomy.ts";

describe("classifyError — envelope-aware (status alone is a lie)", () => {
  test("Bedrock ThrottlingException is 400 but means rate-limit, not bad-request", () => {
    const c = classifyError({ name: "ThrottlingException", statusCode: 400, message: "Too many requests" });
    expect(c.class).toBe("rate-limit");
    expect(c.kind).toBe("exhausted");
    expect(c.scope).toBe("model");
  });

  test("Bedrock on-demand-throughput ValidationException → model-gone (use a profile id)", () => {
    const c = classifyError({
      name: "ValidationException",
      statusCode: 400,
      message: "Invocation with on-demand throughput isn't supported. Retry with the ID of an inference profile.",
    });
    expect(c.class).toBe("model-gone");
  });

  test("Bedrock expired/denied creds → auth (park account)", () => {
    expect(classifyError({ name: "ExpiredTokenException" }).class).toBe("auth");
    expect(classifyError({ name: "AccessDeniedException" }).scope).toBe("account");
  });

  test("Vertex RESOURCE_EXHAUSTED → rate-limit even though it can be a 429-shaped 200", () => {
    const c = classifyError({ statusCode: 429, responseBody: JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded" } }) });
    expect(c.class).toBe("rate-limit");
  });

  test("Vertex NOT_FOUND (Gemini-3 wrong region) → model-gone", () => {
    const c = classifyError({ data: { error: { status: "NOT_FOUND", message: "Publisher Model was not found" } } });
    expect(c.class).toBe("model-gone");
  });

  test("MiniMax failure rides inside an HTTP 200 base_resp", () => {
    expect(classifyError({ body: { base_resp: { status_code: 1008, status_msg: "insufficient balance" } } }).class).toBe("quota");
    expect(classifyError({ body: { base_resp: { status_code: 1002 } } }).class).toBe("rate-limit");
    expect(classifyError({ body: { base_resp: { status_code: 1004 } } }).class).toBe("auth");
  });
});

describe("classifyError — OpenAI wire code/type", () => {
  test("insufficient_quota is billing (account scope), rate_limit_exceeded is the (account,model) pair", () => {
    expect(classifyError({ error: { code: "insufficient_quota" } }).scope).toBe("account");
    expect(classifyError({ error: { code: "rate_limit_exceeded" } }).scope).toBe("model");
  });

  test("Azure codex 'operation unsupported' → bad-request, never a failover hop", () => {
    const c = classifyError({ statusCode: 400, responseBody: JSON.stringify({ error: { message: "The requested operation is unsupported." } }) });
    expect(c.class).toBe("bad-request");
    expect(c.kind).toBe("other");
  });

  test("context_length_exceeded → context-length (compact, don't hop)", () => {
    expect(classifyError({ error: { code: "context_length_exceeded" } }).class).toBe("context-length");
    expect(classifyError("This model's maximum context length is 200000 tokens").class).toBe("context-length");
  });

  test("SambaNova model_deprecated / Groq model_decommissioned → model-gone", () => {
    expect(classifyError({ error: { code: "model_deprecated" } }).class).toBe("model-gone");
    expect(classifyError("Model llama-4-maverick has been decommissioned").class).toBe("model-gone");
  });
});

describe("classifyError — content filter is never a hop", () => {
  test("Azure content filter → content-filter/other", () => {
    const c = classifyError({ statusCode: 400, message: "The response was filtered due to the prompt triggering Azure OpenAI's content management policy" });
    expect(c.class).toBe("content-filter");
    expect(c.kind).toBe("other");
  });
});

describe("classifyError — string + bare-status fallback", () => {
  test("DeepSeek 402 insufficient balance → quota", () => {
    expect(classifyError("402 Insufficient Balance").class).toBe("quota");
  });
  test("bare auth and rate strings", () => {
    expect(classifyError("401 Unauthorized: invalid api key").class).toBe("auth");
    expect(classifyError("429 rate limit reached").class).toBe("rate-limit");
  });
  test("bare HTTP status when nothing else is available", () => {
    expect(classifyError({ statusCode: 503 }).class).toBe("server");
    expect(classifyError({ status: 401 }).class).toBe("auth");
  });
});
