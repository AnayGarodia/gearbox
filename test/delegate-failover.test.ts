// Step 7: a sub-agent isn't covered by the App hop-loop, so delegation runs its
// OWN failover cascade — a recoverable failure (rate/quota/credit/auth/timeout)
// parks the failed pick and re-routes to another model. A real bug never hops.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDelegateTools } from "../src/agent/delegate.ts";
import { clearCooldowns } from "../src/model/cooldown.ts";

process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gearbox-failover-"));

// Provider keys are set per-test and FULLY restored, so this file never leaks a
// stray key (e.g. DeepSeek) into other files' "only Anthropic" routing setups.
const PKEYS = ["ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"];
const savedKeys: Record<string, string | undefined> = {};
beforeEach(() => {
  clearCooldowns();
  for (const k of PKEYS) { savedKeys[k] = process.env[k]; delete process.env[k]; }
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.DEEPSEEK_API_KEY = "test-key";
});
afterEach(() => {
  clearCooldowns();
  for (const k of PKEYS) { if (savedKeys[k] === undefined) delete process.env[k]; else process.env[k] = savedKeys[k]!; }
});

const ORCH = "long unrelated orchestrator prompt about the build pipeline and the deploy flow";

test("a recoverable sub-agent failure parks the pick and fails over to another model", async () => {
  const seen: string[] = [];
  const run = async (p: any) => {
    seen.push(p.model.id);
    // first model hits a rate limit; any later model succeeds.
    if (seen.length === 1) return { text: "", usage: { inputTokens: 0, outputTokens: 0 }, failure: { message: "429 too many requests — rate limit exceeded" } };
    return { text: "report:\ndone", usage: { inputTokens: 0, outputTokens: 0 } };
  };
  const tools = makeDelegateTools({ onEvent: () => {}, run, orchestratorModelId: "claude-opus-4-8", orchestratorPrompt: ORCH });
  const out = await (tools.delegate as any).execute({ task: "refactor the parser in src/parse.ts and src/lex.ts", kind: "code" });
  expect(seen.length).toBe(2); // one hop
  expect(seen[0]).not.toBe(seen[1]); // routed AROUND the parked pick
  expect(String(out)).toContain("done"); // the retry's report is returned, not the failure
});

test("a NON-recoverable failure (a real bug) does NOT hop", async () => {
  const seen: string[] = [];
  const run = async (p: any) => {
    seen.push(p.model.id);
    return { text: "", usage: { inputTokens: 0, outputTokens: 0 }, failure: { message: "TypeError: cannot read property 'x' of undefined" } };
  };
  const tools = makeDelegateTools({ onEvent: () => {}, run, orchestratorModelId: "claude-opus-4-8", orchestratorPrompt: ORCH });
  const out = await (tools.delegate as any).execute({ task: "refactor the parser in src/parse.ts and src/lex.ts", kind: "code" });
  expect(seen.length).toBe(1); // no failover on a genuine error
  expect(String(out)).toContain("failed");
});

test("a PINNED sub-task has nowhere to fail over → one shot, no infinite hop", async () => {
  const seen: string[] = [];
  const run = async (p: any) => {
    seen.push(p.model.id);
    return { text: "", usage: { inputTokens: 0, outputTokens: 0 }, failure: { message: "429 rate limit" } };
  };
  // pin to a model that is NOT the orchestrator's, so the same-model guard doesn't
  // pre-empt; the pin means reroute returns the same pick → the loop stops.
  const tools = makeDelegateTools({
    onEvent: () => {},
    run,
    pinnedModelId: "claude-sonnet-4-6",
    orchestratorModelId: "claude-opus-4-8",
    orchestratorPrompt: ORCH,
  });
  const out = await (tools.delegate as any).execute({ task: "refactor the parser in src/parse.ts and src/lex.ts", kind: "code" });
  expect(seen.length).toBe(1); // a pin cannot hop — it would just re-run itself
  expect(String(out)).toContain("failed");
});
