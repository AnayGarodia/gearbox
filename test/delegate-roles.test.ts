// Step 6: a delegated sub-task can declare a ROLE (explore/review/code) and the
// role's posture — read-only, tool scoping, effort, system hint, and (for review)
// cross-family routing off the author's vendor — flows into the sub-agent run.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDelegateTools } from "../src/agent/delegate.ts";
import { READ_ONLY_TOOLS } from "../src/agent/roles.ts";

// Two provider families so a cross-family reviewer has somewhere else to land.
// Keys are set per-test and fully restored so this file never leaks a stray key
// (e.g. DeepSeek) into other files' "only Anthropic" routing setups.
process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gearbox-delgrole-"));
const PKEYS = ["ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"];
const savedKeys: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of PKEYS) { savedKeys[k] = process.env[k]; delete process.env[k]; }
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.DEEPSEEK_API_KEY = "test-key";
});
afterEach(() => {
  for (const k of PKEYS) { if (savedKeys[k] === undefined) delete process.env[k]; else process.env[k] = savedKeys[k]!; }
});

function capture() {
  const calls: any[] = [];
  const run = async (p: any) => {
    calls.push(p);
    return { text: "report:\nfindings", usage: { inputTokens: 0, outputTokens: 0 } };
  };
  return { calls, run };
}

const ORCH = "long unrelated orchestrator prompt about the build pipeline and the deploy flow";

test("role:explore delegates read-only with the explorer toolset + system hint + low effort", async () => {
  const { calls, run } = capture();
  const tools = makeDelegateTools({ onEvent: () => {}, run, orchestratorModelId: "claude-opus-4-8", orchestratorPrompt: ORCH });
  const out = await (tools.delegate as any).execute({ task: "find where routing picks a model and report the files involved", role: "explore" });
  expect(String(out)).toContain("findings");
  expect(calls.length).toBe(1);
  expect(calls[0].plan).toBe(true); // read-only
  expect(calls[0].allowTools).toEqual(READ_ONLY_TOOLS);
  expect(calls[0].effort).toBe("low");
  expect(calls[0].system).toContain("EXPLORER");
});

test("role:review runs read-only, high-effort, and cross-family (off the author's vendor)", async () => {
  const { calls, run } = capture();
  const tools = makeDelegateTools({ onEvent: () => {}, run, orchestratorModelId: "claude-opus-4-8", orchestratorPrompt: ORCH });
  await (tools.delegate as any).execute({ task: "review the changes in src/pool.ts for correctness and security issues", role: "review" });
  expect(calls.length).toBe(1);
  expect(calls[0].plan).toBe(true);
  expect(calls[0].effort).toBe("high");
  expect(calls[0].system).toContain("REVIEWER");
  // the author is claude-opus → a cross-family reviewer must NOT be claude.
  expect(calls[0].model.provider).not.toBe("anthropic");
  expect(calls[0].model.provider).toBe("deepseek");
});

test("a read-only role is exempt from the same-model guard (isolation is the point)", async () => {
  const { calls, run } = capture();
  // pin the sub-task to the orchestrator's own model: a plain code delegate this
  // small would be refused, but an explore role is allowed (read-only isolation).
  const tools = makeDelegateTools({
    onEvent: () => {},
    run,
    pinnedModelId: "claude-opus-4-8",
    orchestratorModelId: "claude-opus-4-8",
    orchestratorPrompt: ORCH,
  });
  const out = await (tools.delegate as any).execute({ task: "skim the module", role: "explore" });
  expect(String(out)).not.toContain("same model");
  expect(calls.length).toBe(1);
});
