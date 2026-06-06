import { test, expect, beforeEach } from "bun:test";
import { classifyFailure, markExhausted, coolingDown, cooldownReason, clearCooldowns, DEFAULT_COOLDOWN_MS } from "../src/model/cooldown.ts";

beforeEach(() => clearCooldowns());

test("classifyFailure flags quota/rate/credit errors as exhausted, real errors as other", () => {
  for (const m of [
    "429 Too Many Requests",
    "Rate limit reached for gpt-5.5",
    "You exceeded your current quota (insufficient_quota)",
    "Overloaded (529)",
    "ThrottlingException: rate exceeded",
    "RESOURCE_EXHAUSTED",
    "Your credit balance is too low (402)",
    "weekly usage limit reached",
  ]) expect(classifyFailure(m)).toBe("exhausted");

  for (const m of [
    "model produced invalid tool call",
    "ECONNRESET",
    "context length exceeded",
    "400 invalid request: bad schema",
  ]) expect(classifyFailure(m)).toBe("other");
});

test("markExhausted parks a key until it expires", () => {
  markExhausted("acct-1", DEFAULT_COOLDOWN_MS, "429", 1000);
  expect(coolingDown("acct-1", 1000)).toBe(true);
  expect(coolingDown("acct-1", 1000 + DEFAULT_COOLDOWN_MS - 1)).toBe(true);
  expect(coolingDown("acct-1", 1000 + DEFAULT_COOLDOWN_MS + 1)).toBe(false); // expired
  expect(coolingDown("other", 1000)).toBe(false);
});

test("cooldownReason returns the reason only while active", () => {
  markExhausted("k", 10, "rate limited", 0);
  expect(cooldownReason("k", 5)).toBe("rate limited");
  expect(cooldownReason("k", 20)).toBeUndefined();
});
