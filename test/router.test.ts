import { test, expect, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoutingSelector, classify } from "../src/model/router.ts";

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
