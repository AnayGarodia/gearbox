import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTaskMock } from "../src/agent/mock.ts";
import type { AgentEvent } from "../src/agent/events.ts";
import { findModel } from "../src/providers.ts";
import { FixedSelector } from "../src/model/selector.ts";

// Isolate the account store so "needs a key" depends only on env, not real accounts.
process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gearbox-agent-"));

test("mock runner emits text, a full tool lifecycle, and ends with done", async () => {
  const events: AgentEvent[] = [];
  await runTaskMock({ prompt: "hi", messages: [], onEvent: (e) => events.push(e) });

  const types = events.map((e) => e.type);
  expect(types).toContain("text");
  expect(types).toContain("tool-start");
  expect(types).toContain("tool-end");
  expect(types[types.length - 1]).toBe("done");

  // every tool-start must have a matching tool-end (no dangling tool UI)
  const starts = events.filter((e): e is Extract<AgentEvent, { type: "tool-start" }> => e.type === "tool-start");
  const endIds = new Set(events.filter((e) => e.type === "tool-end").map((e) => (e as any).id));
  for (const s of starts) expect(endIds.has(s.id)).toBe(true);
});

test("model registry resolves by label, and the seam needs a key", () => {
  expect(findModel("sonnet-4.6")?.id).toBe("claude-sonnet-4-6");

  const KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "DEEPSEEK_API_KEY"];
  const saved: Record<string, string | undefined> = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    expect(() => new FixedSelector().select({ prompt: "x" })).toThrow();
    process.env.ANTHROPIC_API_KEY = "test-key";
    expect(new FixedSelector().select({ prompt: "x" }).model.provider).toBe("anthropic");
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
