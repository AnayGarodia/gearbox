import { test, expect } from "bun:test";
import type { ModelMessage } from "ai";
import { contextGovernor, contextOverhead, inferCompactionFocus } from "../src/context/governor.ts";

const msg = (n: number): ModelMessage => ({ role: "user", content: "chunk ".repeat(n) });

test("contextOverhead excludes history and user sections", () => {
  expect(contextOverhead([
    { name: "system", tokens: 100 },
    { name: "history", tokens: 1_000 },
    { name: "retrieved", tokens: 50 },
    { name: "user", tokens: 25 },
  ])).toBe(150);
});

test("governor stays idle below the auto-compact threshold", () => {
  const decision = contextGovernor({
    history: [msg(100)],
    prompt: "small task",
    sections: [{ name: "system", tokens: 1_000 }],
    contextWindow: 200_000,
    modelId: "gpt-5.5",
  });
  expect(decision.shouldCompact).toBe(false);
  expect(decision.reason).toContain("below auto-compact threshold");
  expect(decision.focus).toBeUndefined();
});

test("governor includes non-history overhead when deciding to compact", () => {
  const decision = contextGovernor({
    history: [msg(100_000)],
    prompt: "fix context",
    changedFiles: ["src/context/builder.ts"],
    failures: ["bun test test/context.test.ts: failed"],
    sections: [{ name: "system", tokens: 30_000 }],
    contextWindow: 200_000,
    modelId: "gpt-5.5",
  });
  expect(decision.shouldCompact).toBe(true);
  expect(decision.focus).toContain("current task: fix context");
  expect(decision.focus).toContain("src/context/builder.ts");
  expect(decision.focus).toContain("bun test test/context.test.ts");
});

test("governor tightens keepRecent at high pressure", () => {
  const high = contextGovernor({
    history: [msg(150_000)],
    prompt: "large session",
    sections: [{ name: "system", tokens: 30_000 }],
    contextWindow: 200_000,
    modelId: "gpt-5.5",
  });
  expect(high.shouldCompact).toBe(true);
  expect(high.keepRecent).toBeLessThanOrEqual(3);
});

test("focus inference is deterministic and clips long inputs", () => {
  const focus = inferCompactionFocus({
    prompt: "x ".repeat(200),
    changedFiles: ["a.ts", "a.ts", "b.ts"],
    failures: ["first failure ".repeat(20), "first failure ".repeat(20)],
  })!;
  expect(focus).toContain("current task:");
  expect(focus).toContain("files: a.ts, b.ts");
  expect(focus.length).toBeLessThan(360);
});
