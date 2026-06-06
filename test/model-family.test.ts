import { test, expect } from "bun:test";
import { modelFamily } from "../src/model/family.ts";

test("collapses provider-specific ids to a shared family", () => {
  expect(modelFamily("claude-sonnet-4-6")).toBe("claude-sonnet-4");
  expect(modelFamily("bedrock/anthropic.claude-sonnet-4-20250514-v1:0")).toBe("claude-sonnet-4");
  expect(modelFamily("claude-opus-4-8")).toBe("claude-opus-4");
  expect(modelFamily("bedrock/anthropic.claude-opus-4-20250514-v1:0")).toBe("claude-opus-4");
});

test("gemini across direct + vertex", () => {
  expect(modelFamily("gemini-3.5-flash")).toBe("gemini-3.5-flash");
  expect(modelFamily("vertex/gemini-3.5-flash")).toBe("gemini-3.5-flash");
});

test("unknown ids fall back to themselves", () => {
  expect(modelFamily("deepseek-v4-pro")).toBe("deepseek-v4-pro");
});
