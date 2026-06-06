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
