import React from "react";
import { test, expect, beforeEach } from "bun:test";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/ui/App.tsx";
import { FixedSelector } from "../src/model/selector.ts";
import { saveAccounts } from "../src/accounts/store.ts";
import type { AgentEvent, OnEvent } from "../src/agent/events.ts";
import type { ModelMessage } from "ai";

// Integration harness for the TURN LIFECYCLE (R4 root cause). Drives the real App
// via the `runner` seam + scripted AgentEvents — no network — and asserts the
// end-to-end result the way a human would see it. This is the surface where almost
// every reported bug actually lived (busy/abort/queue/summary/timing wiring).
beforeEach(() => {
  process.env.GEARBOX_GHOST = "blocks";
  process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gearbox-lifecycle-"));
  process.env.ANTHROPIC_API_KEY = "x";
  // A STORED account (not just an env key) so the app boots live, not into the
  // onboarding/import splash. The injected runner bypasses creds, so a stub is fine.
  saveAccounts({ version: 1, accounts: [{ id: "anthropic-test", provider: "anthropic", exec: "in-loop", enabled: true, label: "anthropic", auth: { kind: "api-key", ref: "x" }, addedAt: 0 }], defaults: {} } as any);
});

const flush = (ms = 60) => new Promise((r) => setTimeout(r, ms));

// A runner that emits a scripted sequence of AgentEvents through the App's onEvent,
// then returns. Mirrors what the real runner does, deterministically.
function scripted(events: (msgs: ModelMessage[]) => AgentEvent[]) {
  return async ({ messages, onEvent }: { messages: ModelMessage[]; onEvent: OnEvent }) => {
    const seq = events(messages);
    for (const e of seq) onEvent(e);
    const done = seq.find((e): e is Extract<AgentEvent, { type: "done" }> => e.type === "done");
    return { messages, usage: done?.usage ?? { inputTokens: 0, outputTokens: 0 } };
  };
}

const ok = (text: string): AgentEvent[] => [
  { type: "text", text },
  { type: "done", usage: { inputTokens: 100, outputTokens: 20 } },
];

test("a successful turn renders the reply, the timing line, and frees the composer", async () => {
  const { lastFrame, stdin } = render(
    <App selector={new FixedSelector("claude-haiku-4-5")} fullscreen runner={scripted(() => ok("the answer is four"))} />,
  );
  await flush();
  stdin.write("what is 2+2");
  await flush();
  stdin.write("\r");
  await flush(); await flush();
  const f = lastFrame() ?? "";
  expect(f).toContain("the answer is four");
  expect(f).toContain("took"); // the per-turn "took Ns" line fires every turn
  // composer is usable again (busy reset) — a keystroke shows up
  stdin.write("next prompt");
  await flush();
  expect(lastFrame() ?? "").toContain("next prompt");
});

test("an errored turn shows the error and still frees the composer (the offline-stuck class)", async () => {
  const runner = scripted(() => [
    { type: "error", message: "rate limited" },
    { type: "done", usage: { inputTokens: 0, outputTokens: 0 } },
  ]);
  const { lastFrame, stdin } = render(<App selector={new FixedSelector("claude-haiku-4-5")} fullscreen runner={runner} />);
  await flush();
  stdin.write("do a thing");
  await flush();
  stdin.write("\r");
  await flush(); await flush();
  expect(lastFrame() ?? "").toContain("rate limited");
  // not stuck: you can still type
  stdin.write("recovered");
  await flush();
  expect(lastFrame() ?? "").toContain("recovered");
});

test("a turn that changes a file produces an end-of-turn summary", async () => {
  // Include a verification EVENT so the post-turn auto-verify gate is skipped (it
  // keys on checks.length === 0) — otherwise it would shell out to `bun test`.
  const runner = scripted(() => [
    { type: "text", text: "patched it" },
    { type: "file-change", path: "alpha.ts", before: "old", existed: true },
    { type: "verification", command: "bun test", ok: true, summary: "green", intent: "tests" },
    { type: "done", usage: { inputTokens: 10, outputTokens: 5 } },
  ]);
  const { lastFrame, stdin } = render(<App selector={new FixedSelector("claude-haiku-4-5")} fullscreen runner={runner} />);
  await flush();
  stdin.write("fix alpha");
  await flush();
  stdin.write("\r");
  await flush(); await flush();
  const f = lastFrame() ?? "";
  expect(f).toContain("alpha.ts"); // the summary lists the changed file
});

// A runner whose first turn blocks on a gate, so we can submit a second prompt
// WHILE busy (it queues) and control when the first turn ends.
function gatedRunner(firstEnding: "ok" | "error") {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let calls = 0;
  const runner = async ({ messages, onEvent }: { messages: ModelMessage[]; onEvent: OnEvent }) => {
    const which = ++calls;
    if (which === 1) {
      await gate;
      if (firstEnding === "error") onEvent({ type: "error", message: "first turn boom" });
      else onEvent({ type: "text", text: "reply one" });
    } else {
      onEvent({ type: "text", text: `reply ${which}` });
    }
    onEvent({ type: "done", usage: { inputTokens: 1, outputTokens: 1 } });
    return { messages, usage: { inputTokens: 1, outputTokens: 1 } };
  };
  return { runner, release: () => release(), calls: () => calls };
}

test("type-ahead: a prompt queued while busy drains after a SUCCESSFUL turn", async () => {
  const g = gatedRunner("ok");
  const { lastFrame, stdin } = render(<App selector={new FixedSelector("claude-haiku-4-5")} fullscreen runner={g.runner} />);
  await flush();
  stdin.write("first"); await flush(); stdin.write("\r"); await flush(); // turn 1 starts, blocks on gate
  stdin.write("second"); await flush(); stdin.write("\r"); await flush(); // queued while busy
  expect(g.calls()).toBe(1); // second hasn't run yet
  g.release(); await flush(); await flush(); await flush(); // turn 1 completes → drain fires turn 2
  expect(g.calls()).toBe(2);
  expect(lastFrame() ?? "").toContain("reply 2");
});

test("type-ahead: the queue PAUSES after an errored turn, it doesn't auto-fire (L-C)", async () => {
  const g = gatedRunner("error");
  const { lastFrame, stdin } = render(<App selector={new FixedSelector("claude-haiku-4-5")} fullscreen runner={g.runner} />);
  await flush();
  stdin.write("first"); await flush(); stdin.write("\r"); await flush(); // turn 1 starts, blocks
  stdin.write("second"); await flush(); stdin.write("\r"); await flush(); // queued
  g.release(); await flush(); await flush(); await flush(); // turn 1 ERRORS → drain must NOT fire turn 2
  expect(lastFrame() ?? "").toContain("first turn boom");
  expect(g.calls()).toBe(1); // the queued prompt did NOT auto-run into the broken state
});

test("↑ recalls the previous prompt into the composer (iv)", async () => {
  const { lastFrame, stdin } = render(<App selector={new FixedSelector("claude-haiku-4-5")} fullscreen runner={scripted(() => ok("done"))} />);
  await flush();
  stdin.write("remember this prompt"); await flush(); stdin.write("\r"); await flush(); await flush();
  stdin.write("\x1b[A"); // up arrow
  await flush();
  expect(lastFrame() ?? "").toContain("remember this prompt"); // pulled back into the composer
});

test("/clear resets the transcript", async () => {
  const { lastFrame, stdin } = render(<App selector={new FixedSelector("claude-haiku-4-5")} fullscreen runner={scripted(() => ok("ephemeral reply"))} />);
  await flush();
  stdin.write("say something"); await flush(); stdin.write("\r"); await flush(); await flush();
  expect(lastFrame() ?? "").toContain("ephemeral reply");
  stdin.write("/clear"); await flush(); stdin.write("\r"); await flush(); await flush();
  expect(lastFrame() ?? "").not.toContain("ephemeral reply"); // gone after clear
});

test("↑/↑/↓ cycle through multiple past inputs (v)", async () => {
  const { lastFrame, stdin } = render(<App selector={new FixedSelector("claude-haiku-4-5")} fullscreen runner={scripted(() => ok("ok"))} />);
  await flush();
  stdin.write("first cmd"); await flush(); stdin.write("\r"); await flush(); await flush();
  stdin.write("second cmd"); await flush(); stdin.write("\r"); await flush(); await flush();
  stdin.write("\x1b[A"); await flush(); // ↑ → most recent
  expect(lastFrame() ?? "").toContain("second cmd");
  stdin.write("\x1b[A"); await flush(); // ↑ → older
  expect(lastFrame() ?? "").toContain("first cmd");
  stdin.write("\x1b[B"); await flush(); // ↓ → back to newer
  expect(lastFrame() ?? "").toContain("second cmd");
});

test("↑ still recalls history when a /ask or /prefer command (with args) sits in the composer", async () => {
  // The bug: a finished command line like `/ask foo` still matched the command
  // NAME, so the palette stayed "active" and swallowed ↑/↓ (index capped at % 1),
  // freezing prompt-history navigation. The composer should leave the draft and
  // pull the prior prompt back.
  const { lastFrame, stdin } = render(<App selector={new FixedSelector("claude-haiku-4-5")} fullscreen runner={scripted(() => ok("ok"))} />);
  await flush();
  stdin.write("older prompt"); await flush(); stdin.write("\r"); await flush(); await flush();
  stdin.write("/ask how does routing pick a model"); await flush(); // a complete command line, NOT submitted
  expect(lastFrame() ?? "").toContain("/ask how does routing pick a model");
  stdin.write("\x1b[A"); await flush(); // ↑ → must recall history, not get stuck on the draft
  const f = lastFrame() ?? "";
  expect(f).toContain("older prompt");
  expect(f).not.toContain("/ask how does routing pick a model");
});

test("`!` enters sticky bash mode (consumed), esc exits (iii)", async () => {
  const { lastFrame, stdin } = render(<App selector={new FixedSelector("claude-haiku-4-5")} fullscreen runner={scripted(() => ok("x"))} />);
  await flush();
  stdin.write("hi"); await flush(); stdin.write("\r"); await flush(); await flush(); // clear the welcome splash
  stdin.write("!"); await flush();
  expect(lastFrame() ?? "").toContain("esc to exit bash mode"); // entered bash mode, the ! is consumed
  stdin.write("\x1b"); await flush(); // esc
  expect(lastFrame() ?? "").not.toContain("esc to exit bash mode"); // back to normal input
});
