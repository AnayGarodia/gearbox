import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gearbox-vertex-"));
import { addVertexAccount } from "../src/accounts/onboard.ts";
import { getSecret } from "../src/accounts/store.ts";

test("addVertexAccount with no service account uses ADC", async () => {
  const r = await addVertexAccount("my-project", "us-central1");
  expect(r.ok).toBe(true);
  expect(r.account!.provider).toBe("vertex");
  expect(r.account!.auth.kind).toBe("vertex");
  expect((r.account!.auth as any).project).toBe("my-project");
  expect((r.account!.auth as any).location).toBe("us-central1");
  expect((r.account!.auth as any).adc).toBe(true);
  expect((r.account!.auth as any).serviceAccountRef).toBeUndefined();
});

test("addVertexAccount stores a service-account JSON by ref", async () => {
  const sa = JSON.stringify({ type: "service_account", project_id: "p", private_key: "x" });
  const r = await addVertexAccount("proj-2", "us-east1", sa);
  expect(r.ok).toBe(true);
  const ref = (r.account!.auth as any).serviceAccountRef as string;
  expect(ref).toContain(":service-account");
  expect(await getSecret(ref)).toBe(sa);
});

test("addVertexAccount rejects missing project or location", async () => {
  expect((await addVertexAccount("", "us-central1")).ok).toBe(false);
  expect((await addVertexAccount("p", "")).ok).toBe(false);
});

test("addVertexAccount rejects malformed or non-service-account JSON", async () => {
  expect((await addVertexAccount("p", "l", "{not json")).ok).toBe(false);
  const wrong = await addVertexAccount("p", "l", JSON.stringify({ type: "user" }));
  expect(wrong.ok).toBe(false);
  expect(wrong.message).toContain("service-account");
});
