// Failure-kind-aware escalation + verifier-tier caution, under the expected-cost
// engine (no arbitrary bar). Asserted via the ACTUAL pick, with an isolated
// account store (env keys only) so results are deterministic.
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoutingSelector } from "../src/model/router.ts";

process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gearbox-esc-"));
const KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "DEEPSEEK_API_KEY"];
const saved: Record<string, string | undefined> = {};
function only(...present: string[]) {
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  for (const k of present) process.env[k] = "test-key";
}
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const pick = (t: Parameters<RoutingSelector["select"]>[0]) => new RoutingSelector().select(t).model.id;
// A repo with a test net: a code task is supplied verifierTier "tests" so the
// objective treats a miss as cheap → cheap-first; "none" removes the net.
const code = (extra: object = {}) => ({ prompt: "refactor the parser", kind: "code" as const, verifierTier: "tests" as const, ...extra });

test("with a test net, code routes cheap-first (cheapest model clearing the capability floor)", () => {
  only("ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY");
  expect(pick(code())).toBe("deepseek-v4-flash"); // cheapest clearing the 0.4 floor
});

test("a TEST failure climbs hard off the failed cheap model; a MECHANICAL one barely moves", () => {
  only("ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY");
  // a test failure is a reasoning miss → raise the floor hard → climb to a strong model
  expect(pick(code({ escalate: 1, failureKind: "test" }))).toBe("claude-sonnet-4-6");
  // a typecheck failure is an easy, pinpointed fix → floor barely rises → stay cheap
  expect(pick(code({ escalate: 1, failureKind: "typecheck" }))).toBe("deepseek-v4-flash");
});

test("repeated misses climb to the strongest tier", () => {
  only("ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY");
  expect(pick(code({ escalate: 3 }))).toBe("claude-opus-4-8");
});

test("NO verifier net makes quality dominate — code routes to the strongest, not the cheapest", () => {
  only("ANTHROPIC_API_KEY");
  // With a net, the cheapest capable model (haiku) wins; with no net, a silent
  // miss is expensive, so the objective climbs to the strongest available.
  expect(pick(code({ verifierTier: "tests" }))).toBe("claude-haiku-4-5");
  expect(pick(code({ verifierTier: "none" }))).toBe("claude-opus-4-8");
});

test("difficulty never lifts a cheap kind off the cheapest model", () => {
  only("ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY");
  // chat has no floor and a tiny miss cost → cheapest wins regardless of signals.
  const plain = pick({ prompt: "what is a closure", kind: "chat" });
  const heavy = pick({ prompt: "what is a closure", kind: "chat", estTokens: 50_000 });
  expect(heavy).toBe(plain);
});
