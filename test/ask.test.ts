import { test, expect } from "bun:test";
import { loadGearboxDocs, buildAskSystem, looksLikeGearboxQuestion, sessionDigest } from "../src/help/ask.ts";
import type { TurnMeta } from "../src/session.ts";

test("loadGearboxDocs reads the bundled docs and includes known content", () => {
  const docs = loadGearboxDocs();
  expect(docs.length).toBeGreaterThan(1000);
  expect(docs).toContain("routing seam"); // from CLAUDE.md
  expect(docs).toContain("# README.md"); // per-file header present
});

test("buildAskSystem grounds the model in the docs and forbids invention", () => {
  const sys = buildAskSystem("DOC BODY HERE");
  expect(sys).toContain("DOC BODY HERE");
  expect(sys).toContain("Use ONLY the documentation");
  expect(sys).toContain("/help");
});

test("looksLikeGearboxQuestion fires on meta-questions about the tool", () => {
  expect(looksLikeGearboxQuestion("How do I add Azure to my account?")).toBe(true);
  expect(looksLikeGearboxQuestion("what does /effort do?")).toBe(true);
  expect(looksLikeGearboxQuestion("how does routing pick a model in gearbox?")).toBe(true);
  expect(looksLikeGearboxQuestion("can I use a subscription account?")).toBe(true);
});

test("looksLikeGearboxQuestion declines real coding tasks and noise", () => {
  expect(looksLikeGearboxQuestion("fix the bug in src/foo.ts")).toBe(false);
  expect(looksLikeGearboxQuestion("implement a cache for the model list")).toBe(false);
  expect(looksLikeGearboxQuestion("what time is it?")).toBe(false); // a question, but not about Gearbox
  expect(looksLikeGearboxQuestion("add a route to router.ts")).toBe(false); // mutation + file path
  expect(looksLikeGearboxQuestion("hi")).toBe(false);
});

test("looksLikeGearboxQuestion declines questions about THIS conversation (they need history)", () => {
  expect(looksLikeGearboxQuestion("Which model did you use to answer the question")).toBe(false);
  expect(looksLikeGearboxQuestion("which model did you use to answer the question above?")).toBe(false);
  expect(looksLikeGearboxQuestion("why did you pick that model?")).toBe(false);
  expect(looksLikeGearboxQuestion("what model answered my previous question?")).toBe(false);
  expect(looksLikeGearboxQuestion("which account served the last response?")).toBe(false);
  // …but tool-facts questions with no conversation reference still fire
  expect(looksLikeGearboxQuestion("which model is best for chat tasks?")).toBe(true);
  expect(looksLikeGearboxQuestion("How do I add Azure to my account?")).toBe(true);
});

const msgs = (pairs: [string, string][]) =>
  pairs.flatMap(([u, a]) => [
    { role: "user" as const, content: u },
    { role: "assistant" as const, content: a },
  ]);
const turn = (model: string): TurnMeta => ({ model, inputTokens: 10, outputTokens: 5, at: 1 });

test("sessionDigest pairs exchanges with the model that served each turn", () => {
  const d = sessionDigest(msgs([["WHat is capital of India", "New Delhi."]]), [turn("claude-sonnet-4-6")]);
  expect(d).toContain("WHat is capital of India");
  expect(d).toContain("New Delhi.");
  expect(d).toContain("answered by claude-sonnet-4-6");
});

test("sessionDigest is empty for a fresh session and skips per-exchange attribution on a count mismatch", () => {
  expect(sessionDigest([], [])).toBe("");
  // compaction/delegates can desync turns from exchanges — attribution would be
  // a guess, so the models are listed separately instead
  const d = sessionDigest(msgs([["q1", "a1"]]), [turn("m1"), turn("m2")]);
  expect(d).not.toContain("answered by");
  expect(d).toContain("models that served the recent turns");
  expect(d).toContain("m1, m2");
});

test("sessionDigest clips long content and keeps only the recent exchanges", () => {
  const long = "x".repeat(400);
  const pairs: [string, string][] = Array.from({ length: 10 }, (_, i) => [`question ${i}`, i === 9 ? long : `answer ${i}`]);
  const d = sessionDigest(msgs(pairs), pairs.map((_, i) => turn(`model-${i}`)));
  expect(d).not.toContain("question 0"); // older than the last 6
  expect(d).toContain("question 9");
  expect(d).toContain("…"); // the 400-char answer was clipped
  expect(d).not.toContain(long);
});

test("buildAskSystem includes the session block only when a digest is provided", () => {
  const withSession = buildAskSystem("DOCS", "SESSION FACTS");
  expect(withSession).toContain("=== CURRENT SESSION");
  expect(withSession).toContain("SESSION FACTS");
  expect(buildAskSystem("DOCS")).not.toContain("CURRENT SESSION");
});
