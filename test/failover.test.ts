import { test, expect } from "bun:test";
import { runWithFailover } from "../src/agent/failover.ts";
import type { Candidate } from "../src/accounts/resolve.ts";
import type { Account } from "../src/accounts/types.ts";
import { MODELS } from "../src/providers.ts";

const sonnet = MODELS.find((m) => m.id === "claude-sonnet-4-6")!;
const acct = (id: string): Account => ({
  id, slug: id, label: id, provider: "anthropic", exec: "in-loop",
  auth: { kind: "api-key", ref: `${id}:api-key` }, enabled: true, addedAt: 0,
});

test("advances to the next candidate on a credential failure before any output", async () => {
  const used: string[] = [];
  const candidates: Candidate[] = [
    { account: acct("bad"), model: sonnet },
    { account: acct("good"), model: sonnet },
  ];
  const res = await runWithFailover({
    candidates,
    onEvent: () => {},
    recordHealth: () => {},
    resolveCreds: async () => ({ apiKey: "k" }),
    runOne: async ({ account }) => {
      used.push(account.id);
      if (account.id === "bad") {
        return { messages: [], usage: { inputTokens: 0, outputTokens: 0 },
                 failure: { message: "invalid x-api-key", raw: { statusCode: 401, message: "invalid x-api-key" }, producedOutput: false } };
      }
      return { messages: [], usage: { inputTokens: 1, outputTokens: 1 } };
    },
  });
  expect(used).toEqual(["bad", "good"]);
  expect(res.usedAccountId).toBe("good");
});

test("does NOT advance on a real (non-credential) error", async () => {
  const used: string[] = [];
  const candidates: Candidate[] = [{ account: acct("a"), model: sonnet }, { account: acct("b"), model: sonnet }];
  await runWithFailover({
    candidates, onEvent: () => {}, recordHealth: () => {}, resolveCreds: async () => ({ apiKey: "k" }),
    runOne: async ({ account }) => {
      used.push(account.id);
      return { messages: [], usage: { inputTokens: 0, outputTokens: 0 },
               failure: { message: "invalid request: unknown parameter", raw: { statusCode: 400, message: "invalid request: unknown parameter" }, producedOutput: false } };
    },
  });
  expect(used).toEqual(["a"]); // stopped, no failover on real-error
});

test("does NOT advance once output was produced (no mid-stream switch)", async () => {
  const used: string[] = [];
  const candidates: Candidate[] = [{ account: acct("a"), model: sonnet }, { account: acct("b"), model: sonnet }];
  await runWithFailover({
    candidates, onEvent: () => {}, recordHealth: () => {}, resolveCreds: async () => ({ apiKey: "k" }),
    runOne: async ({ account }) => {
      used.push(account.id);
      return { messages: [], usage: { inputTokens: 0, outputTokens: 0 },
               failure: { message: "rate limit", raw: { statusCode: 429 }, producedOutput: true } };
    },
  });
  expect(used).toEqual(["a"]);
});

test("empty pool emits a clear error and reports no used account", async () => {
  const events: any[] = [];
  const res = await runWithFailover({
    candidates: [], onEvent: (e) => events.push(e), recordHealth: () => {},
    resolveCreds: async () => ({ apiKey: "k" }), runOne: async () => ({ messages: [], usage: { inputTokens: 0, outputTokens: 0 } }),
  });
  expect(events.find((e) => e.type === "error")?.message).toContain("/account add");
  expect(res.usedAccountId).toBeUndefined();
});

test("a terminal failure does not report the failed account as used", async () => {
  const candidates = [{ account: acct("only"), model: sonnet }];
  const res = await runWithFailover({
    candidates, onEvent: () => {}, recordHealth: () => {}, resolveCreds: async () => ({ apiKey: "k" }),
    runOne: async () => ({ messages: [], usage: { inputTokens: 0, outputTokens: 0 },
      failure: { message: "invalid x-api-key", raw: { statusCode: 401 }, producedOutput: false } }),
  });
  expect(res.usedAccountId).toBeUndefined();
});
