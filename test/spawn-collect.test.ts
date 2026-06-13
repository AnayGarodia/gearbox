// Async fan-out: spawn_subagent fires sub-agents that run in the background while
// the orchestrator keeps working; collect_subagents gathers them. Tested with a
// stub runner from a NON-git temp cwd (main-workspace path, no real worktrees).
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDelegateTools, type SubAgentRunner } from "../src/agent/delegate.ts";

process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gearbox-spawn-home-"));
process.env.ANTHROPIC_API_KEY = "test-key";

const cwd0 = process.cwd();
const workdir = mkdtempSync(join(tmpdir(), "gearbox-spawn-cwd-")); // NOT a git repo
beforeAll(() => process.chdir(workdir));
afterAll(() => process.chdir(cwd0));

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const longPrompt = "an unrelated long orchestrator prompt about the deploy pipeline and the release process";

function tools(run: SubAgentRunner) {
  return makeDelegateTools({ onEvent: () => {}, run, orchestratorPrompt: longPrompt }) as any;
}

test("spawn returns immediately with a job id; collect(wait) gathers all reports", async () => {
  let started = 0, finished = 0;
  const run: SubAgentRunner = async (p) => { started++; await delay(15); finished++; return { text: `report for: ${p.prompt.slice(0, 12)}`, usage: { inputTokens: 1, outputTokens: 1 } }; };
  const t = tools(run);

  const a = await t.spawn_subagent.execute({ task: "read module A and summarize its public API" });
  expect(String(a)).toContain("Spawned sub-task #");
  expect(finished).toBe(0); // returned before the sub-agent finished

  await t.spawn_subagent.execute({ task: "read module B and list its exported functions" });
  await t.spawn_subagent.execute({ task: "read module C and note any TODOs" });
  expect(started).toBeGreaterThanOrEqual(1); // they began running in the background

  const collected = await t.collect_subagents.execute({ wait: true });
  expect(String(collected)).toContain("Collected 3");
  expect(finished).toBe(3);
  // a second collect has nothing left
  expect(String(await t.collect_subagents.execute({}))).toContain("No spawned sub-tasks");
});

test("collect(wait:false) returns only the already-finished sub-tasks", async () => {
  const run: SubAgentRunner = async (p) => { await delay(p.prompt.includes("slow") ? 80 : 5); return { text: "done", usage: { inputTokens: 1, outputTokens: 1 } }; };
  const t = tools(run);
  await t.spawn_subagent.execute({ task: "quick read of the config file" });
  await t.spawn_subagent.execute({ task: "slow deep analysis of the whole module tree" });
  await delay(30); // the quick one finished, the slow one hasn't
  const partial = await t.collect_subagents.execute({ wait: false });
  expect(String(partial)).toContain("Collected 1");
  expect(String(partial)).toContain("1 still outstanding");
  const rest = await t.collect_subagents.execute({ wait: true });
  expect(String(rest)).toContain("Collected 1");
});

test("the concurrency cap is respected — no more than 8 sub-agents run at once", async () => {
  let concurrent = 0, peak = 0;
  const run: SubAgentRunner = async () => { concurrent++; peak = Math.max(peak, concurrent); await delay(20); concurrent--; return { text: "ok", usage: { inputTokens: 1, outputTokens: 1 } }; };
  const t = tools(run);
  for (let i = 0; i < 15; i++) await t.spawn_subagent.execute({ task: `read file number ${i} and summarize it briefly` });
  await t.collect_subagents.execute({ wait: true });
  expect(peak).toBeLessThanOrEqual(8);
  expect(peak).toBeGreaterThan(1); // genuinely concurrent, not serialized
});
