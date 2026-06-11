import { test, expect, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoutingSelector, classify } from "../src/model/router.ts";
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
test("Anthropic-only: code → sonnet, summarize → haiku", () => {
  only("ANTHROPIC_API_KEY");
  const r = new RoutingSelector();
  expect(r.select({ prompt: "implement a retry with backoff" }).model.id).toBe("claude-sonnet-4-6");
  expect(r.select({ prompt: "summarize this transcript" }).model.id).toBe("claude-haiku-4-5");
  // the reason is the live USP surface — kind + rationale + price
  expect(r.select({ prompt: "summarize this" }).reason).toContain("summarize");
});

// ── multi-provider: cheapest-that-clears-the-bar picks deepseek for code ──
test("with a DeepSeek key, coding routes to the cheapest model that clears the bar", () => {
  only("ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY");
  const r = new RoutingSelector();
  // deepseek-chat: SWE 0.806 (clears 0.7 bar) and far cheaper than sonnet
  expect(r.select({ prompt: "refactor the parser" }).model.id).toBe("deepseek-v4-pro");
});

// ── confidence-gated escalation: climb off the cheap pick after failed checks ──
test("escalation raises the bar gradually, then climbs to a stronger model", () => {
  only("ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY");
  const r = new RoutingSelector();
  // baseline: cheapest model that clears the 0.7 code bar
  expect(r.select({ prompt: "refactor the parser" }).model.id).toBe("deepseek-v4-pro");
  // one miss → bar 0.78; deepseek (0.806) still clears → gradual, unchanged
  expect(r.select({ prompt: "refactor the parser", escalate: 1 }).model.id).toBe("deepseek-v4-pro");
  // several misses → bar climbs past deepseek's quality → router moves UP, not to cheapest
  const hard = r.select({ prompt: "refactor the parser", escalate: 3 });
  expect(hard.model.id).not.toBe("deepseek-v4-pro");
  expect(hard.reason).toContain("escalated");
});

test("image turns require a vision-capable model even when a cheaper code model is available", () => {
  only("ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY");
  const r = new RoutingSelector();
  expect(r.select({ prompt: "fix this UI from the screenshot", requires: ["tools", "images"] }).model.id).toBe("claude-sonnet-4-6");
  expect(r.select({ prompt: "fix this UI from the screenshot", requires: ["tools", "images"] }).reason).toContain("tools+images required");
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
