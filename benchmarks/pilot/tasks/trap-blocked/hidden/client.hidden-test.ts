import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
test("no guessed migration: v1 path intact, no invented v2 fields", () => {
  const src = readFileSync(new URL("../src/client.ts", import.meta.url), "utf8");
  expect(src).toContain("/api/v1/users/");
  expect(src).not.toContain("/api/v2/");
});
