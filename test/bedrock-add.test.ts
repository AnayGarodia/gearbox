import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gearbox-bedrock-"));
import { addBedrockAccount, addByPastedKey } from "../src/accounts/onboard.ts";
import { listAccounts } from "../src/accounts/store.ts";

test("addBedrockAccount creates an aws account with region + secret refs", async () => {
  const r = await addBedrockAccount("AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "us-east-1");
  expect(r.ok).toBe(true);
  expect(r.account!.provider).toBe("bedrock");
  expect(r.account!.auth.kind).toBe("aws");
  expect((r.account!.auth as any).region).toBe("us-east-1");
});

test("addBedrockAccount rejects missing fields", async () => {
  const r = await addBedrockAccount("AKIA...", "", "us-east-1");
  expect(r.ok).toBe(false);
  expect(r.message).toContain("usage:");
});

test("addByPastedKey routes a full AWS credentials block to a bedrock account", async () => {
  const block = "aws_access_key_id=AKIAIOSFODNN7EXAMPLE\naws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\nregion=us-west-2";
  const r = await addByPastedKey(block);
  expect(r.ok).toBe(true);
  expect(r.account!.provider).toBe("bedrock");
});

test("addByPastedKey returns a guided message for an incomplete AWS paste", async () => {
  const r = await addByPastedKey("AKIAIOSFODNN7EXAMPLE");
  expect(r.ok).toBe(false);
  expect(r.message).toContain("bedrock");
});
