import { test, expect } from "bun:test";
import { classifyProviderError, parseRetryAfter, retryDelayMs, MAX_INLINE_RETRY_DELAY_MS } from "../src/agent/errors.ts";

// Classification table: every kind, by status code and by message phrase.
const cases: { name: string; err: unknown; kind: string; retryable: boolean }[] = [
  { name: "401 invalid key", err: { statusCode: 401, message: "invalid x-api-key" }, kind: "auth", retryable: false },
  { name: "403 forbidden", err: { statusCode: 403, message: "Forbidden" }, kind: "auth", retryable: false },
  { name: "expired token by phrase", err: new Error("token has expired, please re-authenticate"), kind: "auth", retryable: false },
  { name: "429 rate limit", err: { statusCode: 429, message: "rate limit exceeded" }, kind: "rate", retryable: true },
  { name: "rate limit by phrase only", err: new Error("Too many requests, slow down"), kind: "rate", retryable: true },
  { name: "insufficient_quota wearing a 429", err: { statusCode: 429, message: "You exceeded your current quota: insufficient_quota" }, kind: "quota", retryable: false },
  { name: "credit balance", err: new Error("Your credit balance is too low to access the Anthropic API."), kind: "quota", retryable: false },
  { name: "413 too large", err: { statusCode: 413, message: "Payload Too Large" }, kind: "overflow", retryable: false },
  { name: "context_length_exceeded", err: { statusCode: 400, message: "This model's maximum context length is 128000 tokens (context_length_exceeded)" }, kind: "overflow", retryable: false },
  { name: "prompt is too long", err: new Error("prompt is too long: 250000 tokens > 200000 maximum"), kind: "overflow", retryable: false },
  { name: "500 internal", err: { statusCode: 500, message: "Internal Server Error" }, kind: "server", retryable: true },
  { name: "529 overloaded", err: { statusCode: 529, message: "Overloaded" }, kind: "server", retryable: true },
  { name: "503 by phrase", err: new Error("Service Unavailable"), kind: "server", retryable: true },
  { name: "econnreset", err: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }), kind: "network", retryable: true },
  { name: "fetch failed", err: new Error("fetch failed"), kind: "network", retryable: true },
  { name: "etimedout", err: { code: "ETIMEDOUT" }, kind: "network", retryable: true },
  { name: "abort", err: Object.assign(new Error("The operation was aborted."), { name: "AbortError" }), kind: "abort", retryable: false },
  { name: "400 invalid request", err: { statusCode: 400, message: "invalid_request_error: messages roles must alternate" }, kind: "invalid", retryable: false },
  { name: "unknown", err: new Error("something inscrutable happened"), kind: "other", retryable: false },
];

for (const c of cases) {
  test(`classify: ${c.name} → ${c.kind}${c.retryable ? " (retryable)" : ""}`, () => {
    const got = classifyProviderError(c.err);
    expect(got.kind).toBe(c.kind as any);
    expect(got.retryable).toBe(c.retryable);
  });
}

test("retry-after header in seconds is parsed to ms", () => {
  const got = classifyProviderError({ statusCode: 429, message: "rate limited", responseHeaders: { "retry-after": "30" } });
  expect(got.kind).toBe("rate");
  expect(got.retryAfterMs).toBe(30_000);
});

test("retry-after header as an HTTP-date is parsed relative to now", () => {
  const now = Date.parse("2026-06-10T12:00:00Z");
  const date = new Date(now + 42_000).toUTCString();
  const got = classifyProviderError({ statusCode: 429, message: "rate limited", responseHeaders: { "retry-after": date } }, now);
  expect(got.retryAfterMs).toBe(42_000);
});

test("parseRetryAfter handles seconds, dates, and garbage", () => {
  expect(parseRetryAfter("30")).toBe(30_000);
  const now = Date.parse("2026-06-10T12:00:00Z");
  expect(parseRetryAfter(new Date(now + 5000).toUTCString(), now)).toBe(5000);
  // a past date clamps to zero, never negative
  expect(parseRetryAfter(new Date(now - 5000).toUTCString(), now)).toBe(0);
  expect(parseRetryAfter("soon")).toBeUndefined();
  expect(parseRetryAfter(undefined)).toBeUndefined();
});

test("retryDelayMs honors retryAfterMs, else exponential with ±10% jitter", () => {
  const fixed = () => 0.5; // jitter factor exactly 1.0
  expect(retryDelayMs({ kind: "rate", retryable: true, retryAfterMs: 7000 }, 0, fixed)).toBe(7000);
  expect(retryDelayMs({ kind: "server", retryable: true }, 0, fixed)).toBe(2000);
  expect(retryDelayMs({ kind: "server", retryable: true }, 1, fixed)).toBe(4000);
  // jitter stays within ±10%
  const d = retryDelayMs({ kind: "server", retryable: true }, 0);
  expect(d).toBeGreaterThanOrEqual(1800);
  expect(d).toBeLessThanOrEqual(2200);
});

test("the inline-retry ceiling exists and is sane", () => {
  expect(MAX_INLINE_RETRY_DELAY_MS).toBe(30_000);
});
