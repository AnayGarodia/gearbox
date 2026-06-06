import { test, expect } from "bun:test";
import { formatAccounts } from "../src/commands.ts";

const acct = (over: any) => ({ id: "anthropic-x", label: "Anthropic", provider: "anthropic", exec: "in-loop", slug: "anthropic", ...over });

test("formatAccounts uses slugs, never numbers", () => {
  const out = formatAccounts([acct({}), acct({ id: "anthropic-y", slug: "anthropic-2" })], null, []);
  expect(out).toContain("/account anthropic");
  expect(out).not.toMatch(/\(or \d+\)/);
});
