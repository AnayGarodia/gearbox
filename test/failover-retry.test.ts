import { test, expect, describe } from "bun:test";
import { isTransient, runWithFailover } from "../src/agent/failover.ts";
import type { Candidate } from "../src/accounts/resolve.ts";
import type { Account } from "../src/accounts/types.ts";
import { MODELS } from "../src/providers.ts";

const sonnet = MODELS.find((m) => m.id === "claude-sonnet-4-6")!;
const acct = (id: string): Account => ({
  id, slug: id, label: id, provider: "anthropic", exec: "in-loop",
  auth: { kind: "api-key", ref: `${id}:api-key` }, enabled: true, addedAt: 0,
});
const noSleep = async () => {};

describe("isTransient", () => {
  test("5xx server errors are transient", () => {
    for (const s of [500, 502, 503, 504]) expect(isTransient({ statusCode: s })).toBe(true);
  });
  test("network blips are transient", () => {
    for (const m of ["fetch failed", "ECONNRESET", "socket hang up", "ETIMEDOUT", "network timeout"])
      expect(isTransient({ message: m })).toBe(true);
    expect(isTransient({ code: "ECONNRESET" })).toBe(true);
  });
  test("client errors and auth are NOT transient", () => {
    for (const s of [400, 401, 403, 404]) expect(isTransient({ statusCode: s })).toBe(false);
    expect(isTransient({ message: "invalid request" })).toBe(false);
  });
  test("rate-limit (429) is not treated as transient here (handled as credential)", () => {
    expect(isTransient({ statusCode: 429 })).toBe(false);
  });
});

describe("runWithFailover · transient retry", () => {
  test("retries the SAME account on a transient error, then succeeds", async () => {
    const used: string[] = [];
    let calls = 0;
    const res = await runWithFailover({
      candidates: [{ account: acct("a"), model: sonnet }, { account: acct("b"), model: sonnet }],
      onEvent: () => {}, recordHealth: () => {}, resolveCreds: async () => ({ apiKey: "k" }),
      maxTransientRetries: 2, sleep: noSleep,
      runOne: async ({ account }) => {
        used.push(account.id);
        if (++calls <= 2) return { messages: [], usage: { inputTokens: 0, outputTokens: 0 }, failure: { message: "fetch failed", raw: { message: "fetch failed" }, producedOutput: false } };
        return { messages: [], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    });
    expect(used).toEqual(["a", "a", "a"]); // initial + 2 retries, same account, never advanced to b
    expect(res.usedAccountId).toBe("a");
  });

  test("gives up after the retry budget and reports terminal (no infinite loop)", async () => {
    const used: string[] = [];
    const events: any[] = [];
    await runWithFailover({
      candidates: [{ account: acct("only"), model: sonnet }],
      onEvent: (e) => events.push(e), recordHealth: () => {}, resolveCreds: async () => ({ apiKey: "k" }),
      maxTransientRetries: 2, sleep: noSleep,
      runOne: async ({ account }) => {
        used.push(account.id);
        return { messages: [], usage: { inputTokens: 0, outputTokens: 0 }, failure: { message: "503 unavailable", raw: { statusCode: 503 }, producedOutput: false } };
      },
    });
    expect(used.length).toBe(3); // initial + 2 retries
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  test("does NOT retry once output has streamed", async () => {
    const used: string[] = [];
    await runWithFailover({
      candidates: [{ account: acct("a"), model: sonnet }],
      onEvent: () => {}, recordHealth: () => {}, resolveCreds: async () => ({ apiKey: "k" }),
      maxTransientRetries: 2, sleep: noSleep,
      runOne: async ({ account }) => {
        used.push(account.id);
        return { messages: [], usage: { inputTokens: 0, outputTokens: 0 }, failure: { message: "fetch failed", raw: { message: "fetch failed" }, producedOutput: true } };
      },
    });
    expect(used).toEqual(["a"]); // produced output → no retry
  });
});
