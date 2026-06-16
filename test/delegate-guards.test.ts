// Delegation guards: don't offload the WHOLE task, and don't SEQUENTIALLY
// delegate to your own model (the "Sonnet delegates the whole task to Sonnet"
// pathology). isWholeTask is pure; the same-model guard is exercised via the
// delegate tool with a stub runner.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWholeTask, makeDelegateTools, sameModelDelegateWorthIt, deriveSubTaskSignals } from "../src/agent/delegate.ts";

// Isolate the account store (no real CLI seats) + give one in-loop key so the
// sub-task routes deterministically to an in-loop Anthropic model.
process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gearbox-delg-"));
process.env.ANTHROPIC_API_KEY = "test-key";

test("isWholeTask flags a sub-task that restates essentially the whole prompt", () => {
  const prompt = "refactor the auth module to use the new token service and update the tests";
  expect(isWholeTask("refactor the auth module to use the new token service and update the tests", prompt)).toBe(true);
  expect(isWholeTask("refactor the auth module and update the token service tests now please", prompt)).toBe(true);
});

test("isWholeTask does NOT flag a bounded chunk of the prompt", () => {
  const prompt = "refactor the auth module to use the new token service and update the tests";
  expect(isWholeTask("read src/token.ts and summarize its public API", prompt)).toBe(false);
  expect(isWholeTask("run the test suite and report which tests fail", prompt)).toBe(false);
});

test("isWholeTask is inert for a very short prompt (can't judge)", () => {
  expect(isWholeTask("fix it", "fix it")).toBe(false);
});

// The same-model guard: a sequential delegate to the orchestrator's own model is
// refused (no sub-agent runs); a delegate to a DIFFERENT model proceeds.
test("a sequential delegate to the orchestrator's OWN model is refused, not run", async () => {
  let ran = 0;
  const tools = makeDelegateTools({
    onEvent: () => {},
    run: async () => { ran++; return { text: "did it", usage: { inputTokens: 0, outputTokens: 0 } }; },
    pinnedModelId: "claude-sonnet-4-6", // force the sub-task to route to sonnet
    orchestratorModelId: "claude-sonnet-4-6", // ...which is the orchestrator's model
    orchestratorPrompt: "some unrelated long orchestrator prompt about the build pipeline and deploy",
  });
  const out = await (tools.delegate as any).execute({ task: "write a small helper to format dates" });
  expect(String(out)).toContain("same model");
  expect(ran).toBe(0); // the guard fired before any sub-agent ran
});

// The relaxation: a SUBSTANTIAL same-model sub-task (multi-file, the context-
// isolation case) is allowed to run, because a fresh focused window is a real
// benefit even on the same model — just like Claude Code / Goose subagents.
test("a substantial same-model sub-task is ALLOWED (context isolation is a real benefit)", async () => {
  let ran = 0;
  const tools = makeDelegateTools({
    onEvent: () => {},
    run: async () => { ran++; return { text: "did it", usage: { inputTokens: 0, outputTokens: 0 } }; },
    pinnedModelId: "claude-sonnet-4-6",
    orchestratorModelId: "claude-sonnet-4-6",
    orchestratorPrompt: "some unrelated long orchestrator prompt about the build pipeline and deploy",
  });
  // names several files → touchedFiles ≥ 2 → worth isolating into a sub-agent.
  const out = await (tools.delegate as any).execute({
    task: "rename the OldClient symbol across src/a.ts, src/b.ts, and src/c.ts and update their imports",
  });
  expect(String(out)).not.toContain("same model");
  expect(ran).toBe(1); // the sub-agent ran
});

test("sameModelDelegateWorthIt: multi-file or large working set yes, tiny no", () => {
  expect(sameModelDelegateWorthIt({ touchedFiles: ["a.ts", "b.ts"], estTokens: 100 })).toBe(true);
  expect(sameModelDelegateWorthIt({ touchedFiles: [], estTokens: 9_000 })).toBe(true);
  expect(sameModelDelegateWorthIt({ touchedFiles: ["a.ts"], estTokens: 500 })).toBe(false);
  expect(sameModelDelegateWorthIt(deriveSubTaskSignals("write a small helper to format dates"))).toBe(false);
});
