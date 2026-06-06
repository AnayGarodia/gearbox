import { test, expect } from "bun:test";
import { rankCandidates, type Candidate } from "../src/accounts/resolve.ts";
import type { Account } from "../src/accounts/types.ts";
import { MODELS } from "../src/providers.ts";

const A = (over: Partial<Account>): Account => ({
  id: "x", slug: "x", label: "x", provider: "anthropic", exec: "in-loop",
  auth: { kind: "api-key", ref: "x:api-key" }, enabled: true, addedAt: 0, ...over,
});
const sonnet = MODELS.find((m) => m.id === "claude-sonnet-4-6")!;

test("healthy ranks before unknown before unhealthy", () => {
  const accts = [
    A({ id: "bad", slug: "bad", health: { state: "invalid", checkedAt: 1 } }),
    A({ id: "good", slug: "good", health: { state: "ok", checkedAt: 1 } }),
    A({ id: "meh", slug: "meh" }), // unknown
  ];
  const ranked = rankCandidates(sonnet, accts).map((c: Candidate) => c.account.id);
  expect(ranked).toEqual(["good", "meh", "bad"]);
});

test("includes cross-provider accounts and binds the right model id", () => {
  const accts = [
    A({ id: "anth", slug: "anth", provider: "anthropic", health: { state: "ok", checkedAt: 1 } }),
    A({ id: "bed", slug: "bed", provider: "bedrock", health: { state: "ok", checkedAt: 1 },
        auth: { kind: "aws", accessKeyIdRef: "a", secretKeyRef: "b", region: "us-east-1" } }),
  ];
  const ranked = rankCandidates(sonnet, accts);
  const bed = ranked.find((c) => c.account.id === "bed");
  expect(bed?.model.provider).toBe("bedrock"); // bound to the bedrock sonnet spec
});

test("excludes accounts whose provider serves no model in the family", () => {
  const accts = [A({ id: "ds", slug: "ds", provider: "deepseek", health: { state: "ok", checkedAt: 1 } })];
  expect(rankCandidates(sonnet, accts)).toHaveLength(0);
});

test("the provider default leads its health tier", () => {
  const accts = [
    A({ id: "a", slug: "a", provider: "anthropic", health: { state: "ok", checkedAt: 1 } }),
    A({ id: "b", slug: "b", provider: "anthropic", health: { state: "ok", checkedAt: 1 } }),
  ];
  // Without a default, input order wins (a first).
  expect(rankCandidates(sonnet, accts).map((c) => c.account.id)).toEqual(["a", "b"]);
  // With b set as the anthropic default, b leads.
  expect(rankCandidates(sonnet, accts, { anthropic: "b" }).map((c) => c.account.id)).toEqual(["b", "a"]);
  // A healthy default still loses to nothing, but an UNHEALTHY default does NOT jump the tier:
  const mixed = [
    A({ id: "good", slug: "good", provider: "anthropic", health: { state: "ok", checkedAt: 1 } }),
    A({ id: "deaddefault", slug: "deaddefault", provider: "anthropic", health: { state: "invalid", checkedAt: 1 } }),
  ];
  expect(rankCandidates(sonnet, mixed, { anthropic: "deaddefault" }).map((c) => c.account.id)).toEqual(["good", "deaddefault"]);
});
