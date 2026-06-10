// Regression tests for the v0.2.96 provider-reliability batch — every entry
// here was a confirmed live breakage from the adversarial provider audit.
import { test, expect } from "bun:test";
import { bedrockCallableId } from "../src/providers.ts";
import { classifyError, isModelAccessDenied } from "../src/accounts/health.ts";
import { classifyFailure, cooldownScope } from "../src/model/cooldown.ts";
import { parseRateHeaders } from "../src/model/rate-headers.ts";
import { unavailableModelHint } from "../src/agent/run.ts";

// ── Bedrock: inference-profile geo prefixes ───────────────────────────────────

test("bedrockCallableId prefixes by region geo (bare ids reject on-demand invocation)", () => {
  expect(bedrockCallableId("anthropic.claude-sonnet-4-20250514-v1:0", "us-east-1")).toBe("us.anthropic.claude-sonnet-4-20250514-v1:0");
  expect(bedrockCallableId("amazon.nova-pro-v1:0", "eu-west-1")).toBe("eu.amazon.nova-pro-v1:0");
  expect(bedrockCallableId("meta.llama4-maverick-17b-instruct-v1:0", "ap-southeast-2")).toBe("apac.meta.llama4-maverick-17b-instruct-v1:0");
  expect(bedrockCallableId("anthropic.claude-haiku-4-5-20251001-v1:0", undefined)).toBe("us.anthropic.claude-haiku-4-5-20251001-v1:0"); // sensible default
});

test("bedrockCallableId passes through already-prefixed ids and ARNs", () => {
  expect(bedrockCallableId("us.anthropic.claude-sonnet-4-20250514-v1:0", "us-east-1")).toBe("us.anthropic.claude-sonnet-4-20250514-v1:0");
  expect(bedrockCallableId("global.amazon.nova-pro-v1:0", "eu-west-1")).toBe("global.amazon.nova-pro-v1:0");
  expect(bedrockCallableId("arn:aws:bedrock:us-east-1:123:inference-profile/x", "eu-west-1")).toBe("arn:aws:bedrock:us-east-1:123:inference-profile/x");
});

// ── classifyError: the wrong-fix-hint gaps ────────────────────────────────────

test("DeepSeek 402 'Insufficient Balance' and OpenRouter 'Insufficient credits' classify as no-credit", () => {
  expect(classifyError("deepseek", { statusCode: 402, message: "Insufficient Balance" })).toBe("no-credit");
  expect(classifyError("openrouter", { statusCode: 402, message: "Insufficient credits. Add more using https://openrouter.ai/credits" })).toBe("no-credit");
  expect(classifyError("deepseek", { message: "Insufficient Balance" })).toBe("no-credit"); // status sometimes stripped by the SDK
});

test("Google's free-tier 429 ('check your plan and billing details') is rate-limited, not no-credit", () => {
  const e = { statusCode: 429, message: "You exceeded your current quota, please check your plan and billing details. RESOURCE_EXHAUSTED" };
  expect(classifyError("google", e)).toBe("rate-limited"); // 'add credit' was the wrong fix for an RPM throttle
});

test("Bedrock 403 'don't have access to the model' is NOT an invalid key", () => {
  const e = { statusCode: 403, message: "You don't have access to the model with the specified model ID." };
  expect(isModelAccessDenied(e)).toBe(true);
  expect(classifyError("bedrock", e)).toBe("real-error"); // never 'replace the key'
  // Signature failures still classify as credential problems.
  expect(classifyError("bedrock", { statusCode: 403, message: "The security token included in the request is invalid. UnrecognizedClientException" })).toBe("invalid");
});

test("unavailableModelHint names the Bedrock Model-access fix and the Vertex global-location fix", () => {
  const spec = { id: "bedrock/x", provider: "bedrock", sdkId: "anthropic.claude-haiku-4-5-20251001-v1:0", label: "x", contextWindow: 1 } as any;
  const bedrockHint = unavailableModelHint("You don't have access to the model with the specified model ID.", spec);
  expect(bedrockHint).toContain("Model access");
  expect(bedrockHint).not.toContain("replace the key");
  const vspec = { id: "vertex/g", provider: "vertex", sdkId: "gemini-3.1-pro-preview", label: "g", contextWindow: 1 } as any;
  const vertexHint = unavailableModelHint("Publisher Model projects/p/locations/us-central1/publishers/google/models/gemini-3.1-pro-preview was not found", vspec);
  expect(vertexHint).toContain("global");
  expect(vertexHint).not.toContain("/account refresh");
});

// ── live hop-loop mirrors ─────────────────────────────────────────────────────

test("classifyFailure: 'Insufficient Balance/credits' hop instead of dying raw", () => {
  expect(classifyFailure("Insufficient Balance")).toBe("exhausted");
  expect(classifyFailure("Insufficient credits. Add more at openrouter.ai")).toBe("exhausted");
});

test("cooldownScope: Google's billing-flavored 429 parks the MODEL, not the whole account", () => {
  expect(cooldownScope("You exceeded your current quota, please check your plan and billing details.")).toBe("model");
  expect(cooldownScope("Insufficient Balance")).toBe("account"); // a drained wallet still parks account-wide
});

// ── Azure rate-limit reset headers ────────────────────────────────────────────

test("Azure bare-second resets parse as now+N (Date.parse('10') is Oct 2001)", () => {
  const now = 1_700_000_000_000;
  const windows = parseRateHeaders("azure", {
    "x-ratelimit-limit-requests": "100",
    "x-ratelimit-remaining-requests": "40",
    "x-ratelimit-reset-requests": "10",
    "x-ratelimit-limit-tokens": "10000",
    "x-ratelimit-remaining-tokens": "2000",
    "x-ratelimit-reset-tokens": "300",
  }, now);
  const reqs = windows.find((w) => w.type.includes("request"));
  const toks = windows.find((w) => w.type.includes("token"));
  expect(reqs?.resetsAt).toBe(Math.floor(now / 1000) + 10);
  expect(toks?.resetsAt).toBe(Math.floor(now / 1000) + 300);
});

test("phantom far-future resets are rejected ('45' must not become the year 2045)", () => {
  const now = 1_700_000_000_000;
  const windows = parseRateHeaders("azure", {
    "x-ratelimit-limit-requests": "100",
    "x-ratelimit-remaining-requests": "40",
    "x-ratelimit-reset-requests": "45",
  }, now);
  expect(windows[0]?.resetsAt).toBe(Math.floor(now / 1000) + 45);
});

test("OpenAI Go-durations and Anthropic RFC3339 still parse (with day units)", () => {
  const now = 1_700_000_000_000;
  const w1 = parseRateHeaders("openai", {
    "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "1", "x-ratelimit-reset-requests": "6m30s",
  }, now);
  expect(w1[0]?.resetsAt).toBe(Math.floor(now / 1000) + 390);
  const w2 = parseRateHeaders("openai", {
    "x-ratelimit-limit-tokens": "100", "x-ratelimit-remaining-tokens": "1", "x-ratelimit-reset-tokens": "1d2h",
  }, now);
  expect(w2[0]?.resetsAt).toBe(Math.floor(now / 1000) + 86400 + 7200);
  const iso = new Date(now + 60_000).toISOString();
  const w3 = parseRateHeaders("anthropic", {
    "anthropic-ratelimit-requests-limit": "100", "anthropic-ratelimit-requests-remaining": "5", "anthropic-ratelimit-requests-reset": iso,
  }, now);
  expect(w3[0]?.resetsAt).toBe(Math.floor((now + 60_000) / 1000));
});
