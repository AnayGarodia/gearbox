import { test, expect } from "bun:test";
import { loadGearboxDocs, buildAskSystem, looksLikeGearboxQuestion } from "../src/help/ask.ts";

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
