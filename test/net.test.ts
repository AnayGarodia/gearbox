import { test, expect } from "bun:test";
import { isNetworkError } from "../src/ui/net.ts";

test("isNetworkError flags connectivity failures, not API errors", () => {
  expect(isNetworkError("getaddrinfo ENOTFOUND api.anthropic.com")).toBe(true);
  expect(isNetworkError("fetch failed")).toBe(true);
  expect(isNetworkError(new Error("ECONNREFUSED 127.0.0.1:443"))).toBe(true);
  expect(isNetworkError("connect ETIMEDOUT")).toBe(true);
  // undici / AI-SDK shapes that the old regex missed (the reported offline case)
  expect(isNetworkError("Cannot connect to API: Connect Timeout Error (attempted address: api.anthropic.com:443, timeout: 10000ms)")).toBe(true);
  expect(isNetworkError("Failed after 3 attempts. Last error: Connect Timeout Error")).toBe(true);
  // not network: real API/auth errors should pass through unchanged
  expect(isNetworkError("401 invalid api key")).toBe(false);
  expect(isNetworkError("rate limit exceeded")).toBe(false);
  expect(isNetworkError("model not found")).toBe(false);
});
