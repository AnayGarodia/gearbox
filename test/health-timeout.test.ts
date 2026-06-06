import { test, expect } from "bun:test";
import { withTimeout } from "../src/accounts/health.ts";

test("withTimeout resolves the inner value when fast", async () => {
  const v = await withTimeout(Promise.resolve("ok"), 1000, "fallback");
  expect(v).toBe("ok");
});

test("withTimeout returns the fallback when the inner promise is slow", async () => {
  const slow = new Promise<string>((r) => setTimeout(() => r("late"), 50));
  const v = await withTimeout(slow, 10, "fallback");
  expect(v).toBe("fallback");
});
