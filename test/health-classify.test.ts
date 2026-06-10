import { test, expect } from "bun:test";
import { classifyError } from "../src/accounts/health.ts";

test("401 / invalid key → invalid", () => {
  expect(classifyError("anthropic", { statusCode: 401, message: "invalid x-api-key" })).toBe("invalid");
  expect(classifyError("openai", { message: "Incorrect API key provided" })).toBe("invalid");
});

test("expired token / not logged in → expired", () => {
  expect(classifyError("claude-cli", { message: "not logged in" })).toBe("expired");
  expect(classifyError("codex-cli", { message: "token expired, please re-authenticate" })).toBe("expired");
});

test("429 / rate limit / overloaded → rate-limited", () => {
  expect(classifyError("anthropic", { statusCode: 429, message: "rate limit" })).toBe("rate-limited");
  expect(classifyError("anthropic", { message: "Overloaded" })).toBe("rate-limited");
});

test("credit / quota / billing → no-credit", () => {
  expect(classifyError("anthropic", { message: "Your credit balance is too low" })).toBe("no-credit");
  expect(classifyError("openai", { message: "insufficient_quota" })).toBe("no-credit");
});

test("network / 500 / unknown → real-error (not credential-class)", () => {
  expect(classifyError("anthropic", { statusCode: 503, message: "upstream error" })).toBe("real-error");
  expect(classifyError("anthropic", { message: "fetch failed" })).toBe("real-error");
});

// Regression: testAccount/errMessage failures carry the status only in TEXT
// ("HTTP 401", "… (HTTP 429) from <url>"). A non-JSON 401/429 body used to
// classify as real-error and never reach the credential-failover path.
test("HTTP status carried only in the message text still classifies", () => {
  expect(classifyError("azure", { message: "HTTP 401" })).toBe("invalid");
  expect(classifyError("azure", { message: "HTTP 401 from https://r.openai.azure.com/openai/models" })).toBe("invalid");
  expect(classifyError("openai", { message: "HTTP 429 from https://api.openai.com/v1/models" })).toBe("rate-limited");
  expect(classifyError("deepseek", { message: "HTTP 402" })).toBe("no-credit");
  expect(classifyError("azure", { message: "HTTP 500" })).toBe("real-error");
});

// Azure's classic 401 body names a "subscription key", not an "api key".
test("Azure 'invalid subscription key' → invalid", () => {
  expect(classifyError("azure", { message: "Access denied due to invalid subscription key or wrong API endpoint. Make sure to provide a valid key for an active subscription." })).toBe("invalid");
});
