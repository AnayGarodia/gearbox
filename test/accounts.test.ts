import { test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setSecret, getSecret, deleteSecret,
  putAccount, getAccount, listAccounts, accountsForProvider,
  defaultAccount, setDefaultAccount, removeAccount, secretRefs,
} from "../src/accounts/store.ts";
import type { Account } from "../src/accounts/types.ts";

// Force the deterministic file store (the keychain path is OS-dependent / can
// prompt) and an isolated home so the suite never touches the real ~/.gearbox.
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "gearbox-acct-"));
  process.env.GEARBOX_HOME = home;
  process.env.GEARBOX_SECRET_STORE = "file";
});
afterAll(() => {
  delete process.env.GEARBOX_HOME;
  delete process.env.GEARBOX_SECRET_STORE;
});

const mk = (over: Partial<Account> = {}): Account => ({
  id: "anthropic-work", label: "Anthropic (work)", provider: "anthropic",
  exec: "in-loop", auth: { kind: "api-key", ref: "anthropic-work:api-key" },
  enabled: true, addedAt: 1, ...over,
});

test("secret round-trips through the encrypted file store", async () => {
  await setSecret("anthropic-work:api-key", "sk-ant-secret");
  expect(await getSecret("anthropic-work:api-key")).toBe("sk-ant-secret");
  expect(await getSecret("missing")).toBeNull();
  await deleteSecret("anthropic-work:api-key");
  expect(await getSecret("anthropic-work:api-key")).toBeNull();
});

test("encrypted file does not contain the plaintext secret", async () => {
  await setSecret("k:api-key", "sk-ant-PLAINTEXT-SHOULD-NOT-APPEAR");
  const raw = (await import("node:fs")).readFileSync(join(home, "credentials.enc"), "utf8");
  expect(raw).not.toContain("PLAINTEXT-SHOULD-NOT-APPEAR");
});

test("account registry: put / get / list / per-provider / default", () => {
  putAccount(mk());
  putAccount(mk({ id: "anthropic-personal", label: "Anthropic (personal)" }));
  putAccount(mk({ id: "or-1", provider: "openrouter", label: "OpenRouter", auth: { kind: "openai-compat", ref: "or-1:api-key" }, baseUrl: "https://openrouter.ai/api/v1" }));

  expect(listAccounts()).toHaveLength(3);
  expect(accountsForProvider("anthropic")).toHaveLength(2);
  expect(getAccount("or-1")?.baseUrl).toBe("https://openrouter.ai/api/v1");
  // first account of a provider becomes its default
  expect(defaultAccount("anthropic")?.id).toBe("anthropic-work");
  setDefaultAccount("anthropic", "anthropic-personal");
  expect(defaultAccount("anthropic")?.id).toBe("anthropic-personal");
});

test("removeAccount reassigns the default and wipes its secrets", async () => {
  const a = mk();
  putAccount(a);
  putAccount(mk({ id: "anthropic-personal" }));
  await setSecret("anthropic-work:api-key", "sk-ant-x");

  await removeAccount("anthropic-work");
  expect(getAccount("anthropic-work")).toBeUndefined();
  expect(await getSecret("anthropic-work:api-key")).toBeNull(); // secret cleaned up
  expect(defaultAccount("anthropic")?.id).toBe("anthropic-personal"); // default moved
});

test("secretRefs enumerates every secret an account owns", () => {
  const aws = mk({ id: "aws-1", provider: "bedrock", auth: { kind: "aws", accessKeyIdRef: "aws-1:akid", secretKeyRef: "aws-1:secret", sessionTokenRef: "aws-1:token", region: "us-east-2" } });
  expect(secretRefs(aws).sort()).toEqual(["aws-1:akid", "aws-1:secret", "aws-1:token"]);
  expect(secretRefs(mk())).toEqual(["anthropic-work:api-key"]);
});
