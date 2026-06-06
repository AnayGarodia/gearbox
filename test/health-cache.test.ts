import { test, expect } from "bun:test";
import { isFresh } from "../src/accounts/health.ts";

test("isFresh true within TTL, false beyond", () => {
  const now = 1_000_000;
  expect(isFresh({ state: "ok", checkedAt: now - 60_000 }, now)).toBe(true);   // 1m old
  expect(isFresh({ state: "ok", checkedAt: now - 10 * 60_000 }, now)).toBe(false); // 10m old
  expect(isFresh(undefined, now)).toBe(false);
});
