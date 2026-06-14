import React from "react";
import { test, expect, beforeEach, afterEach } from "bun:test";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/ui/App.tsx";
import { FixedSelector } from "../src/model/selector.ts";
import { saveAccounts } from "../src/accounts/store.ts";
import { requestUserAnswer, setAskHandler } from "../src/ask.ts";
import { setPermissionHandler } from "../src/permission.ts";

// App installs GLOBAL permission/ask handlers as a singleton. ink-testing-library
// does not auto-unmount, so without this the handlers leak into later test files
// (concurrent) and hang anything that writes a file or asks. Unmount + clear.
const mounted: Array<() => void> = [];
afterEach(() => {
  for (const u of mounted.splice(0)) try { u(); } catch {}
  setPermissionHandler(null);
  setAskHandler(null);
});

let root = "";
beforeEach(() => {
  process.env.GEARBOX_GHOST = "blocks";
  process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gearbox-ask-"));
  process.env.ANTHROPIC_API_KEY = "x";
  root = mkdtempSync(join(tmpdir(), "gearbox-askroot-"));
  saveAccounts({ version: 1, accounts: [{ id: "a", provider: "anthropic", exec: "in-loop", enabled: true, label: "anthropic", auth: { kind: "api-key", ref: "x" }, addedAt: 0 }], defaults: {} } as any);
});

const flush = (ms = 50) => new Promise((r) => setTimeout(r, ms));

test("ask_user renders the picker and arrow+enter resolves the chosen option", async () => {
  const { lastFrame, stdin, unmount } = render(
    <App selector={new FixedSelector("claude-haiku-4-5")} fullscreen root={root} runner={async ({ messages }) => ({ messages, usage: { inputTokens: 0, outputTokens: 0 } })} />,
  );
  mounted.push(unmount);
  await flush();
  // The agent (via the ask_user tool) asks a question:
  const answerP = requestUserAnswer({ root, questions: [{ question: "Which language?", options: [{ label: "TypeScript" }, { label: "Python" }] }] });
  await flush();
  const f = lastFrame() ?? "";
  expect(f).toContain("Which language?");
  expect(f).toContain("TypeScript");
  expect(f).toContain("Python");

  stdin.write("\x1b[B"); // down → Python
  await flush();
  stdin.write("\r"); // enter → select & finish
  const answers = await answerP;
  expect(answers).toEqual([{ question: "Which language?", answers: ["Python"] }]);
  // the prompt is gone afterward
  await flush();
  expect(lastFrame() ?? "").not.toContain("Which language?");
});

test("multi-select: space toggles, enter confirms the set", async () => {
  const { stdin, unmount } = render(
    <App selector={new FixedSelector("claude-haiku-4-5")} fullscreen root={root} runner={async ({ messages }) => ({ messages, usage: { inputTokens: 0, outputTokens: 0 } })} />,
  );
  mounted.push(unmount);
  await flush();
  const answerP = requestUserAnswer({ root, questions: [{ question: "Features?", multiSelect: true, options: [{ label: "auth" }, { label: "billing" }, { label: "search" }] }] });
  await flush();
  stdin.write(" "); // toggle auth (cursor 0)
  await flush();
  stdin.write("\x1b[B"); stdin.write("\x1b[B"); // → search
  await flush();
  stdin.write(" "); // toggle search
  await flush();
  stdin.write("\r"); // confirm
  expect(await answerP).toEqual([{ question: "Features?", answers: ["auth", "search"] }]);
});

test("esc skips → resolves null (the tool then tells the model to proceed)", async () => {
  const { stdin, unmount } = render(
    <App selector={new FixedSelector("claude-haiku-4-5")} fullscreen root={root} runner={async ({ messages }) => ({ messages, usage: { inputTokens: 0, outputTokens: 0 } })} />,
  );
  mounted.push(unmount);
  await flush();
  const answerP = requestUserAnswer({ root, questions: [{ question: "X?", options: [{ label: "a" }, { label: "b" }] }] });
  await flush();
  stdin.write("\x1b"); // esc
  expect(await answerP).toBeNull();
});
