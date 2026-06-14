import React from "react";
import { test, expect, beforeEach, afterEach } from "bun:test";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/ui/App.tsx";
import { FixedSelector } from "../src/model/selector.ts";
import { saveAccounts } from "../src/accounts/store.ts";
import { setPermissionHandler } from "../src/permission.ts";
import { setAskHandler } from "../src/ask.ts";

const mounted: Array<() => void> = [];
beforeEach(() => {
  process.env.GEARBOX_GHOST = "blocks";
  process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gearbox-steer-"));
  process.env.ANTHROPIC_API_KEY = "x";
  saveAccounts({ version: 1, accounts: [{ id: "a", provider: "anthropic", exec: "in-loop", enabled: true, label: "anthropic", auth: { kind: "api-key", ref: "x" }, addedAt: 0 }], defaults: {} } as any);
});
afterEach(() => {
  for (const u of mounted.splice(0)) try { u(); } catch {}
  setPermissionHandler(null);
  setAskHandler(null);
});
const flush = (ms = 60) => new Promise((r) => setTimeout(r, ms));

test("typing while busy STEERS the turn (soft-abort + continue with the new message), not queue", async () => {
  const calls: string[] = [];
  const runner = async ({ prompt, messages, onEvent, signal }: any) => {
    calls.push(prompt);
    if (calls.length === 1) {
      onEvent({ type: "text", text: "starting the first thing" });
      // Stay busy until the steer soft-aborts us.
      await new Promise<void>((res) => {
        if (signal?.aborted) return res();
        signal?.addEventListener("abort", () => res(), { once: true });
      });
      return { messages, usage: { inputTokens: 0, outputTokens: 0 } };
    }
    onEvent({ type: "text", text: "redirected per your steer" });
    onEvent({ type: "done", usage: { inputTokens: 0, outputTokens: 0 } });
    return { messages, usage: { inputTokens: 0, outputTokens: 0 } };
  };

  const { lastFrame, stdin, unmount } = render(<App selector={new FixedSelector("claude-haiku-4-5")} fullscreen runner={runner} />);
  mounted.push(unmount);
  await flush();
  stdin.write("do the first thing"); await flush();
  stdin.write("\r"); await flush(); // turn 1 running, blocked on abort
  expect(calls.length).toBe(1);

  // Steer mid-turn.
  stdin.write("actually do this other thing instead"); await flush();
  stdin.write("\r"); await flush(); await flush(); await flush();

  expect(calls.length).toBe(2); // the steer ran as a continuation, not a queue-after
  expect(calls[1]).toContain("actually do this other thing instead");
  expect(lastFrame() ?? "").toContain("redirected per your steer");
});
