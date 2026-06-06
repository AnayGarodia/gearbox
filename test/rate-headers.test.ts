import { test, expect } from "bun:test";
import { parseRateHeaders, parseGoDuration } from "../src/model/rate-headers.ts";

const NOW = 1_000_000_000_000; // ms

test("parseGoDuration handles compound Go durations", () => {
  expect(parseGoDuration("1s")).toBe(1);
  expect(parseGoDuration("6m0s")).toBe(360);
  expect(parseGoDuration("114h18m0s")).toBe(114 * 3600 + 18 * 60);
  expect(parseGoDuration("300ms")).toBeCloseTo(0.3, 5);
  expect(parseGoDuration("")).toBeUndefined();
  expect(parseGoDuration("garbage")).toBeUndefined();
});

test("Anthropic headers → api:requests/api:tokens utilization with RFC3339 reset", () => {
  const out = parseRateHeaders("anthropic", {
    "anthropic-ratelimit-requests-limit": "100",
    "anthropic-ratelimit-requests-remaining": "75",
    "anthropic-ratelimit-requests-reset": "2001-09-09T01:48:00Z",
    "anthropic-ratelimit-tokens-limit": "1000000",
    "anthropic-ratelimit-tokens-remaining": "500000",
  }, NOW);
  const req = out.find((r) => r.type === "api:requests")!;
  expect(req.utilization).toBeCloseTo(0.25, 5); // 1 - 75/100
  expect(req.resetsAt).toBe(Math.floor(Date.parse("2001-09-09T01:48:00Z") / 1000));
  const tok = out.find((r) => r.type === "api:tokens")!;
  expect(tok.utilization).toBeCloseTo(0.5, 5);
});

test("OpenAI x-ratelimit headers → utilization with Go-duration reset", () => {
  const out = parseRateHeaders("openai", {
    "x-ratelimit-limit-requests": "60",
    "x-ratelimit-remaining-requests": "59",
    "x-ratelimit-reset-requests": "1s",
    "x-ratelimit-limit-tokens": "150000",
    "x-ratelimit-remaining-tokens": "149000",
    "x-ratelimit-reset-tokens": "6m0s",
  }, NOW);
  const req = out.find((r) => r.type === "api:requests")!;
  expect(req.utilization).toBeCloseTo(1 - 59 / 60, 5);
  expect(req.resetsAt).toBe(Math.floor(NOW / 1000) + 1);
  const tok = out.find((r) => r.type === "api:tokens")!;
  expect(tok.resetsAt).toBe(Math.floor(NOW / 1000) + 360);
});

test("missing limit → that window is skipped (can't compute utilization), never throws", () => {
  // Azure often omits the limit header, sending only remaining.
  const out = parseRateHeaders("azure", { "x-ratelimit-remaining-requests": "10" }, NOW);
  expect(out.find((r) => r.type === "api:requests")).toBeUndefined();
  expect(parseRateHeaders("anthropic", {}, NOW)).toEqual([]);
  expect(parseRateHeaders("deepseek", { "x-ratelimit-remaining-requests": "5" }, NOW)).toEqual([]); // no limit → nothing
});

test("utilization is clamped to [0,1]", () => {
  const out = parseRateHeaders("openai", {
    "x-ratelimit-limit-requests": "60",
    "x-ratelimit-remaining-requests": "75", // remaining > limit (provider quirk)
  }, NOW);
  expect(out.find((r) => r.type === "api:requests")!.utilization).toBe(0);
});
