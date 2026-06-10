// The ARM control plane — the path that actually creates Azure deployments.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArmId, accountMatchesHost, armCreateDeployment, armDeleteDeployment, clearArmCaches } from "../src/accounts/azure-arm.ts";

const saved = process.env.GEARBOX_HOME;
beforeEach(() => {
  process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gearbox-arm-"));
  clearArmCaches();
});
afterEach(() => {
  if (saved === undefined) delete process.env.GEARBOX_HOME;
  else process.env.GEARBOX_HOME = saved;
  clearArmCaches();
});

const ACCT_ID = "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.CognitiveServices/accounts/my-res";

test("parseArmId extracts subscription, resource group, and account name", () => {
  expect(parseArmId(ACCT_ID)).toEqual({ subscriptionId: "sub-1", resourceGroup: "rg-1", name: "my-res" });
  expect(parseArmId("/subscriptions/x/other")).toBeNull();
});

test("accountMatchesHost joins on subdomain or any advertised endpoint", () => {
  expect(accountMatchesHost({ name: "my-res" }, "my-res.openai.azure.com")).toBe(true);
  expect(accountMatchesHost({ name: "my-res" }, "my-res.services.ai.azure.com")).toBe(true);
  expect(accountMatchesHost({ name: "other", properties: { endpoint: "https://my-res.services.ai.azure.com/" } }, "my-res.services.ai.azure.com")).toBe(true);
  expect(accountMatchesHost({ name: "other" }, "my-res.openai.azure.com")).toBe(false);
});

// A fake az + ARM universe: token exec, subscription walk, deployment PUT.
const fakeExec = ((cmd: string[]) => {
  if (cmd[0] === "az") return { stdout: Buffer.from(JSON.stringify({ accessToken: "tok", expires_on: Math.floor(Date.now() / 1000) + 3600 })), stderr: Buffer.alloc(0), exitCode: 0 };
  return { stdout: Buffer.alloc(0), stderr: Buffer.from("unknown"), exitCode: 1 };
}) as any;

function fakeArm(opts: { putStatus?: (body: any, attempt: number) => { status: number; body: string }; deleteStatus?: number } = {}) {
  const calls: { method: string; url: string; body?: any }[] = [];
  let putAttempts = 0;
  const f = (async (url: any, init?: any) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url: u, body });
    if (u.includes("/subscriptions?")) return new Response(JSON.stringify({ value: [{ subscriptionId: "sub-1" }] }), { status: 200 });
    if (u.includes("/providers/Microsoft.CognitiveServices/accounts?")) {
      return new Response(JSON.stringify({ value: [{ id: ACCT_ID, name: "my-res", properties: { endpoint: "https://my-res.services.ai.azure.com/" } }] }), { status: 200 });
    }
    if (u.includes("/models?")) return new Response(JSON.stringify({ value: [{ model: { name: "gpt-4o", version: "2024-11-20" } }] }), { status: 200 });
    if (method === "PUT") {
      putAttempts++;
      const r = opts.putStatus?.(body, putAttempts) ?? { status: 201, body: "{}" };
      return new Response(r.body, { status: r.status });
    }
    if (method === "DELETE") return new Response("", { status: opts.deleteStatus ?? 200 });
    return new Response("{}", { status: 200 });
  }) as any;
  return { fetch: f, calls };
}

test("armCreateDeployment finds the account, PUTs the ARM body, caches the ref", async () => {
  const arm = fakeArm();
  const r = await armCreateDeployment("my-res.services.ai.azure.com", "my-dep", "gpt-4o", "GlobalStandard", arm.fetch, fakeExec);
  expect(r.ok).toBe(true);
  const put = arm.calls.find((c) => c.method === "PUT")!;
  expect(put.url).toContain(`${ACCT_ID}/deployments/my-dep`);
  expect(put.url).toContain("management.azure.com");
  expect(put.body.sku).toEqual({ name: "GlobalStandard", capacity: 50 });
  expect(put.body.properties.model).toEqual({ format: "OpenAI", name: "gpt-4o" });
  // Second call: the subscription walk is skipped (ref disk-cached).
  const arm2 = fakeArm();
  await armCreateDeployment("my-res.services.ai.azure.com", "dep2", "gpt-4o", "Standard", arm2.fetch, fakeExec);
  expect(arm2.calls.some((c) => c.url.includes("/subscriptions?"))).toBe(false);
});

test("a 400 demanding a model version retries once with the looked-up version", async () => {
  const arm = fakeArm({
    putStatus: (body, attempt) =>
      attempt === 1
        ? { status: 400, body: JSON.stringify({ error: { code: "BadRequest", message: "The model version is required." } }) }
        : { status: 201, body: "{}" },
  });
  const r = await armCreateDeployment("my-res.services.ai.azure.com", "my-dep", "gpt-4o", "Standard", arm.fetch, fakeExec);
  expect(r.ok).toBe(true);
  const puts = arm.calls.filter((c) => c.method === "PUT");
  expect(puts).toHaveLength(2);
  expect(puts[1]!.body.properties.model.version).toBe("2024-11-20");
});

test("403 names the role; delete treats ARM 404 as gone", async () => {
  const arm = fakeArm({ putStatus: () => ({ status: 403, body: JSON.stringify({ error: { message: "AuthorizationFailed" } }) }) });
  const r = await armCreateDeployment("my-res.services.ai.azure.com", "d", "gpt-4o", "Standard", arm.fetch, fakeExec);
  expect(r.ok).toBe(false);
  expect(r.note).toContain("Cognitive Services Contributor");
  const armDel = fakeArm({ deleteStatus: 404 });
  expect((await armDeleteDeployment("my-res.services.ai.azure.com", "gone", armDel.fetch, fakeExec)).ok).toBe(true);
});

test("a missing az CLI fails with the install/login fix, not a stack trace", async () => {
  const noAz = ((cmd: string[]) => ({ stdout: Buffer.alloc(0), stderr: Buffer.from("az: not found"), exitCode: 1 })) as any;
  const arm = fakeArm();
  const r = await armCreateDeployment("my-res.services.ai.azure.com", "d", "gpt-4o", "Standard", arm.fetch, noAz);
  expect(r.ok).toBe(false);
  expect(r.note).toContain("az login");
});

// ── the token ladder (device sign-in / az / service principal) ────────────────
import { armAccessToken, armDeviceLogin, armLogout, hasArmLogin } from "../src/accounts/azure-arm.ts";

// Keep ladder tests off the real keychain and the real az binary.
process.env.GEARBOX_SECRET_STORE = "file";

const noAzExec = ((_cmd: string[]) => ({ stdout: Buffer.alloc(0), stderr: Buffer.from("az: not found"), exitCode: 1 })) as any;

function fakeAuth(opts: { pendingPolls?: number } = {}) {
  let polls = 0;
  const calls: { url: string; body: string }[] = [];
  const f = (async (url: any, init?: any) => {
    const u = String(url);
    const body = String(init?.body ?? "");
    calls.push({ url: u, body });
    if (u.includes("/devicecode")) {
      return new Response(JSON.stringify({ device_code: "dev-1", user_code: "ABCD-1234", verification_uri: "https://microsoft.com/devicelogin", interval: 0, expires_in: 900 }), { status: 200 });
    }
    if (u.includes("/token") && body.includes("device_code")) {
      polls++;
      if (polls <= (opts.pendingPolls ?? 1)) return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 });
      return new Response(JSON.stringify({ access_token: "ACCESS-1", refresh_token: "REFRESH-1", expires_in: 3600 }), { status: 200 });
    }
    if (u.includes("/token") && body.includes("refresh_token")) {
      return new Response(JSON.stringify({ access_token: "ACCESS-2", refresh_token: "REFRESH-2", expires_in: 3600 }), { status: 200 });
    }
    if (u.includes("/token") && body.includes("client_credentials")) {
      return new Response(JSON.stringify({ access_token: "SP-TOKEN", expires_in: 3600 }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as any;
  return { fetch: f, calls };
}

test("device sign-in: shows the code, polls past pending, stores the refresh token", async () => {
  await armLogout();
  const auth = fakeAuth({ pendingPolls: 2 });
  let shown: any = null;
  const r = await armDeviceLogin((info) => { shown = info; }, auth.fetch, async () => {});
  expect(r.ok).toBe(true);
  expect(shown.userCode).toBe("ABCD-1234");
  expect(shown.url).toContain("devicelogin");
  expect(await hasArmLogin()).toBe(true);
});

test("with a stored sign-in, the ladder works with NO az at all (and rotates the token)", async () => {
  const auth = fakeAuth();
  await armDeviceLogin(() => {}, auth.fetch, async () => {}); // sign in fresh (beforeEach wiped the home)
  clearArmCaches(); // drop the access token the login primed — force the refresh path
  const t = await armAccessToken(auth.fetch, noAzExec);
  expect("token" in t && t.token).toBe("ACCESS-2");
  const refreshCall = auth.calls.find((c) => c.body.includes("refresh_token"));
  expect(refreshCall).toBeTruthy();
  expect(auth.calls.some((c) => c.body.includes("client_credentials"))).toBe(false);
  await armLogout();
  expect(await hasArmLogin()).toBe(false);
});

test("service-principal env vars are the CI rung; without anything the error names all three fixes", async () => {
  await armLogout();
  clearArmCaches();
  process.env.AZURE_TENANT_ID = "t-1";
  process.env.AZURE_CLIENT_ID = "c-1";
  process.env.AZURE_CLIENT_SECRET = "s-1";
  const auth = fakeAuth();
  const t = await armAccessToken(auth.fetch, noAzExec);
  expect("token" in t && t.token).toBe("SP-TOKEN");
  delete process.env.AZURE_TENANT_ID;
  delete process.env.AZURE_CLIENT_ID;
  delete process.env.AZURE_CLIENT_SECRET;
  clearArmCaches();
  const none = await armAccessToken(auth.fetch, noAzExec);
  expect("error" in none).toBe(true);
  if ("error" in none) {
    expect(none.error).toContain("/account login");
    expect(none.error).toContain("az login");
    expect(none.error).toContain("AZURE_CLIENT_SECRET");
  }
});
