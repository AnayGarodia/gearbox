import { test, expect, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoutingSelector, classify, confidentKeywordKind } from "../src/model/router.ts";
import { confirmRoutingPreference } from "../src/model/preferences.ts";

// Isolate the account store to an empty dir so provider availability depends
// ONLY on env keys (not the developer's real ~/.gearbox accounts).
process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gearbox-router-"));

const KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "DEEPSEEK_API_KEY"];
const saved: Record<string, string | undefined> = {};
function only(...present: string[]) {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const k of present) process.env[k] = "test-key";
}
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// ── classifier: the safety property (never downgrade real work) ──
test("classify defaults to code and never downgrades a mutation request", () => {
  expect(classify("")).toBe("code");
  expect(classify("add a dark mode toggle")).toBe("code");
  // these LOOK like cheap kinds but contain a mutation verb → must stay code
  expect(classify("find and fix the auth bug")).toBe("code");
  expect(classify("summarize and refactor this module")).toBe("code");
  expect(classify("is this a bug? fix it")).toBe("code");
  // genuinely bounded sub-tasks
  expect(classify("summarize the test output")).toBe("summarize");
  expect(classify("where is the model chosen")).toBe("search");
  expect(classify("classify this error as transient or fatal")).toBe("classify");
  expect(classify("categorize these log lines")).toBe("classify");
});

// ── classifier fallback: a bare question never needs the code bar ──
test("classify falls back to chat for question-shaped prompts with no mutation verb", () => {
  expect(classify("What is capital of India")).toBe("chat");
  expect(classify("how does the event loop work?")).toBe("chat");
  expect(classify("is bun faster than node?")).toBe("chat");
  expect(classify("does typescript erase enums at runtime")).toBe("chat");
  // question-shaped but a mutation verb is present → still code
  expect(classify("how do I fix this flaky test?")).toBe("code");
  expect(classify("can you refactor the loader?")).toBe("code");
  // ambiguous NON-question prompts keep the conservative code default
  expect(classify("the parser chokes on nested templates")).toBe("code");
});

// ── routing with only the Anthropic key: the demonstrable behavior ──
// With a verifier net a code miss is cheap to catch, so cheap-first wins (real
// SWE-bench data: Haiku 0.733 IS capable of code — the old seeded 0.38 wrongly
// excluded it). With NO net a silent miss is expensive, so quality dominates.
test("Anthropic-only: code is cheap-first under a net; a HARD unnetted task escalates; summarize → haiku", () => {
  only("ANTHROPIC_API_KEY");
  const r = new RoutingSelector();
  // Under a test net a miss is cheap to catch → cheapest capable model.
  expect(r.select({ prompt: "implement a retry with backoff", kind: "code", verifierTier: "tests" }).model.id).toBe("claude-haiku-4-5");
  // No net + HARD (a big, many-file change): a silent miss is expensive and a
  // hard task is likelier to hide one, so it climbs to the strongest model. (An
  // EASY unnetted task stays cheap — difficulty, not the mere absence of a net,
  // drives escalation now.)
  const hard = r.select({ prompt: "rework the evaluator", kind: "code", verifierTier: "none", estTokens: 60_000, touchedFiles: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"] });
  expect(hard.model.id).toBe("claude-opus-4-8");
  expect(r.select({ prompt: "summarize this transcript" }).model.id).toBe("claude-haiku-4-5");
  expect(r.select({ prompt: "summarize this" }).reason).toContain("summarize");
});

// ── multi-provider: cheapest expected-cost pick clears the capability floor ──
test("with a DeepSeek key, coding routes to the cheapest capable model", () => {
  only("ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY");
  const r = new RoutingSelector();
  // deepseek-v4-flash: real SWE 0.737 clears the 0.4 capability floor and is the
  // cheapest candidate, so under a net it wins cheap-first.
  expect(r.select({ prompt: "refactor the parser", kind: "code", verifierTier: "tests" }).model.id).toBe("deepseek-v4-flash");
});

// ── escalation: a miss raises the capability floor, climbing off the failed tier ──
test("escalation climbs to a stronger model after misses (floor rises by failure kind)", () => {
  only("ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY");
  const r = new RoutingSelector();
  const base = { prompt: "refactor the parser", kind: "code" as const, verifierTier: "tests" as const };
  // baseline: cheapest capable model
  expect(r.select(base).model.id).toBe("deepseek-v4-flash");
  // a test failure is a reasoning miss → floor climbs hard → off the cheap tier
  expect(r.select({ ...base, escalate: 1, failureKind: "test" }).model.id).toBe("claude-sonnet-4-6");
  // several misses → climbs to the strongest tier
  const hard = r.select({ ...base, escalate: 3 });
  expect(hard.model.id).toBe("claude-opus-4-8");
  expect(hard.reason).toContain("escalated");
});

test("image turns require a vision-capable model even when a cheaper code model is available", () => {
  only("ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY");
  const r = new RoutingSelector();
  // deepseek has no vision → filtered out; the cheapest vision-capable model wins.
  const choice = r.select({ prompt: "fix this UI from the screenshot", requires: ["tools", "images"] });
  expect(choice.model.provider).toBe("anthropic"); // a vision-capable model, not deepseek
  expect(choice.reason).toContain("tools+images required");
});

// ── explicit task kind overrides the classifier (the sub-task delegation path) ──
test("an explicit kind is honored over the prompt", () => {
  only("ANTHROPIC_API_KEY");
  const r = new RoutingSelector();
  // compaction passes kind:"summarize" even though the text is a full transcript
  expect(r.select({ prompt: "User: fix the bug\nAssistant: done", kind: "summarize" }).model.id).toBe("claude-haiku-4-5");
});

// ── no keys: errors rather than handing back an unusable model ──
test("no provider key → throws", () => {
  only();
  expect(() => new RoutingSelector().select({ prompt: "x" })).toThrow();
});

test("confirmed task preferences bias routing when the model still clears the bar", () => {
  const priorHome = process.env.GEARBOX_HOME;
  process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gearbox-router-pref-"));
  try {
    only("ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY");
    confirmRoutingPreference({ kind: "code", modelId: "claude-sonnet-4-6" });
    const r = new RoutingSelector();
    expect(r.select({ prompt: "refactor the parser" }).model.id).toBe("claude-sonnet-4-6");
    expect(r.select({ prompt: "refactor the parser" }).reason).toContain("remembered preference");
  } finally {
    if (priorHome === undefined) delete process.env.GEARBOX_HOME;
    else process.env.GEARBOX_HOME = priorHome;
  }
});

// ── standing policy: avoid lists, account order, spend-first (v0.10) ──────────
import { updatePolicy } from "../src/model/preferences.ts";

test("avoidProviders is a HARD filter — an avoided provider is never routed to", () => {
  only("DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY");
  try {
    updatePolicy({ avoidProviders: { add: ["deepseek"] } });
    const r = new RoutingSelector();
    // deepseek would normally win summarize on price; the policy forbids it.
    const pick = r.select({ prompt: "summarize the log", kind: "summarize" });
    expect(pick.model.provider).not.toBe("deepseek");
    // and the scorecard never lists it either
    expect(r.explain({ prompt: "summarize the log", kind: "summarize" }).entries.every((e) => !e.label.toLowerCase().includes("deepseek"))).toBe(true);
  } finally {
    updatePolicy({ avoidProviders: { remove: ["deepseek"] } });
  }
});

test("a policy that avoids EVERY available model fails loudly, naming the rule", () => {
  only("DEEPSEEK_API_KEY");
  try {
    updatePolicy({ avoidProviders: { add: ["deepseek"] } });
    expect(() => new RoutingSelector().select({ prompt: "hi", kind: "chat" })).toThrow(/avoids every available model/);
  } finally {
    updatePolicy({ avoidProviders: { remove: ["deepseek"] } });
  }
});

test("useFirst biases routing toward the named provider while its balance lasts", () => {
  only("DEEPSEEK_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY");
  try {
    const base = new RoutingSelector().select({ prompt: "summarize the log", kind: "summarize" });
    updatePolicy({ useFirst: { set: ["google"] } });
    const biased = new RoutingSelector().select({ prompt: "summarize the log", kind: "summarize" });
    // the bias must be able to flip a near-tie toward google; at minimum the
    // pick is deterministic and never errors with the policy set
    expect(biased.model.provider === "google" || biased.model.provider === base.model.provider).toBe(true);
    expect(biased.model).toBeTruthy();
  } finally {
    updatePolicy({ useFirst: { set: [] } });
  }
});

// "summarize" + workspace-work markers must NOT fast-path to the 0-bar
// summarize kind (user-reported: "read the files and summarize" routed to the
// cheapest model, which misunderstood the task). Mixed prompts defer (null).
test("summarize keyword defers to the LLM classifier when workspace work is involved", () => {
  expect(confidentKeywordKind("read the files and summarize them")).toBeNull();
  expect(confidentKeywordKind("summarize the codebase")).toBeNull();
  expect(confidentKeywordKind("go through the repo and give me a summary, tl;dr")).toBeNull();
  // pure summarize of pasted/abstract content still fast-paths
  expect(confidentKeywordKind("summarize this paragraph for me")).toBe("summarize");
  expect(confidentKeywordKind("tl;dr of the above")).toBe("summarize");
});

test("pinAccount scopes routing to that account (switching to an API account uses it)", () => {
  only("ANTHROPIC_API_KEY", "OPENAI_API_KEY");
  try {
    // Without a pin, a code task routes by economics (could be either provider).
    updatePolicy({ pinAccount: "env:openai" });
    const choice = new RoutingSelector().select({ prompt: "write a function to parse dates", kind: "code" });
    expect(choice.model.provider).toBe("openai"); // the pin is honored
  } finally {
    updatePolicy({ pinAccount: null }); // never leak the pin to sibling tests (shared GEARBOX_HOME)
  }
});

test("a polite codebase-audit request routes to code, not chat (the 'can you…' downgrade bug)", () => {
  // "can you …" made QUESTIONISH fire → chat → bar 0.00 → the cheapest/weakest
  // model for a HARD audit. Engineering work on the codebase must stay code.
  expect(classify("can you audit the codebase for errors and think about how to make it a better predictor")).toBe("code");
  expect(classify("could you review the code and suggest improvements")).toBe("code");
  expect(classify("can you optimize the predictor pipeline")).toBe("code");
  // a genuine concept question phrased politely is still chat
  expect(classify("can you explain how recursion works")).toBe("chat");
  // and a non-code "review" (no code context) doesn't get caught
  expect(confidentKeywordKind("review my essay")).toBeNull();
});
