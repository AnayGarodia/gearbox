import { test, expect } from "bun:test";
import { uniqueSlug } from "../src/accounts/store.ts";

test("uniqueSlug returns the base when free", () => {
  expect(uniqueSlug("claude", [])).toBe("claude");
});

test("uniqueSlug suffixes on collision", () => {
  expect(uniqueSlug("claude", ["claude"])).toBe("claude-2");
  expect(uniqueSlug("claude", ["claude", "claude-2"])).toBe("claude-3");
});

test("uniqueSlug normalizes to kebab", () => {
  expect(uniqueSlug("Claude (Work)", [])).toBe("claude-work");
});
