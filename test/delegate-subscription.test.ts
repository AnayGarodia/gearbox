// S-B: delegation on a subscription-only setup runs the sub-task through the
// vendor binary (one-shot, cwd-scoped) instead of erroring "add an API key".
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDelegateTools } from "../src/agent/delegate.ts";
import { putAccount } from "../src/accounts/store.ts";

// Isolate the store and clear every provider env key so the ONLY route is the
// claude-cli seat we add. (Mirrors test/router-subscription.test.ts setup.)
const ENV_KEYS = [
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "DEEPSEEK_API_KEY",
  "GEARBOX_HOME",
];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gearbox-delegate-sub-"));
  putAccount({
    id: "claude-max", label: "Claude Max", provider: "claude-cli", exec: "cli",
    auth: { kind: "cli", binary: "claude" }, enabled: true, addedAt: 0,
  });
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

const inLoopRunner = async () => ({ text: "in-loop report", usage: { inputTokens: 1, outputTokens: 1 } });

test("subscription-only: delegate runs via the seat's CLI, not 'add an API key'", async () => {
  const events: any[] = [];
  let cliOpts: any = null;
  const fakeCli = async (o: any) => {
    cliOpts = o;
    return {
      messages: [...o.messages, { role: "user", content: o.prompt }, { role: "assistant", content: "seat report: done" }],
      usage: { inputTokens: 50, outputTokens: 20 },
    } as any;
  };
  const tools = makeDelegateTools({ onEvent: (e) => events.push(e), run: inLoopRunner, runCli: fakeCli as any });
  const result = await (tools.delegate as any).execute({ task: "rename foo to bar in src/x.ts", kind: "code" }, {});

  expect(result).toContain("seat report: done");
  expect(cliOpts).toBeTruthy();
  expect(cliOpts.binary).toBe("claude");
  expect(cliOpts.prompt).toContain("rename foo to bar"); // task rides in the prompt
  expect(cliOpts.deferTerminal).toBe(true); // no stray error/done into the parent turn
  expect(cliOpts.sessionId).toBeUndefined(); // clean one-shot
  // The user sees WHERE it ran: the tool head names the seat.
  const start = events.find((e) => e.type === "tool-start" && e.name === "delegate");
  expect(start.arg).toContain("(subscription)");
});

test("subscription-only: a CLI failure surfaces as a failed report, not a throw", async () => {
  const fakeCli = async (o: any) => ({
    messages: [...o.messages, { role: "user", content: o.prompt }],
    usage: { inputTokens: 0, outputTokens: 0 },
    failure: { message: "Codex session expired for claude-max. Run /account login claude-max" },
  }) as any;
  const tools = makeDelegateTools({ onEvent: () => {}, run: inLoopRunner, runCli: fakeCli as any });
  const result = await (tools.delegate as any).execute({ task: "do a thing", kind: "code" }, {});
  expect(result).toContain("failed");
  expect(result).toContain("session expired");
});

test("with an API key present, delegation stays in-loop (CLI runner untouched)", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test";
  let cliCalled = false;
  const fakeCli = async () => { cliCalled = true; return { messages: [], usage: { inputTokens: 0, outputTokens: 0 } } as any; };
  const tools = makeDelegateTools({ onEvent: () => {}, run: inLoopRunner, runCli: fakeCli as any });
  const result = await (tools.delegate as any).execute({ task: "refactor the parser in src/p.ts", kind: "code" }, {});
  expect(result).toContain("in-loop report");
  expect(cliCalled).toBe(false);
});
