import { test, expect } from "bun:test";
import { badgeFor } from "../src/commands.ts";

test("badgeFor maps state → label", () => {
  expect(badgeFor("ok")).toMatch(/ready/);
  expect(badgeFor("expired")).toMatch(/expired/);
  expect(badgeFor("invalid")).toMatch(/invalid/);
  expect(badgeFor("rate-limited")).toMatch(/limited/);
  expect(badgeFor("no-credit")).toMatch(/credit/);
  expect(badgeFor("unknown")).toMatch(/—|unknown/);
});
