import { test, expect } from "bun:test";
import { registerAskHandler } from "../src/ask.ts";
import { createTools } from "../src/tools.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Root-scoped handlers (a unique root per test) so these are deterministic even
// when App-rendering test files run concurrently and set the GLOBAL handler —
// the root match bypasses the global.

test("a root handler resolves; ask_user formats the answers for the model", async () => {
  const root = mkdtempSync(join(tmpdir(), "ask-b1-"));
  registerAskHandler(root, async (req) => req.questions.map((q) => ({ question: q.question, answers: ["chosen"] })));
  try {
    const tools = createTools(undefined, root);
    const out = await (tools.ask_user as any).execute({ questions: [{ question: "Lang?", options: [{ label: "TS" }, { label: "Py" }] }] });
    expect(out).toContain("Lang?");
    expect(out).toContain("→ chosen");
  } finally {
    registerAskHandler(root, null);
  }
});

test("a null answer (dismissed / headless) → tool tells the model to proceed", async () => {
  const root = mkdtempSync(join(tmpdir(), "ask-b2-"));
  registerAskHandler(root, async () => null);
  try {
    const tools = createTools(undefined, root);
    const out = await (tools.ask_user as any).execute({ questions: [{ question: "Lang?", options: [{ label: "TS" }, { label: "Py" }] }] });
    expect(out.toLowerCase()).toContain("best judgment");
  } finally {
    registerAskHandler(root, null);
  }
});
