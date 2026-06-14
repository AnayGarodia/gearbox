import { test, expect } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCliLines, buildCliArgs, runCliTask } from "../src/agent/cli-backend.ts";
import type { AgentEvent } from "../src/agent/events.ts";

// Fixtures lifted from experiments/cli-backend-spike.md (the real schemas).
const CLAUDE = [
  `{"type":"system","subtype":"init","session_id":"sess-abc","model":"claude-opus-4-8"}`,
  `{"type":"assistant","message":{"content":[{"type":"text","text":"hello "},{"type":"tool_use","id":"tu1","name":"read_file","input":{"path":"x.ts"}}],"usage":{"input_tokens":10,"output_tokens":2}}}`,
  `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu1","is_error":false,"content":"ok"}]}}`,
  `{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}`,
  `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1780718400,"rateLimitType":"seven_day","utilization":0.81}}`,
  `{"type":"result","subtype":"success","is_error":false,"result":"done","usage":{"input_tokens":8861,"output_tokens":4},"total_cost_usd":0.19,"session_id":"sess-abc"}`,
];

const CODEX = [
  `{"type":"thread.started","thread_id":"th-1"}`,
  `{"type":"turn.started"}`,
  `{"type":"item.completed","item":{"id":"c1","type":"command_execution","command":"ls","status":"completed"}}`,
  `{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"hi there"}}`,
  `{"type":"turn.completed","usage":{"input_tokens":18787,"output_tokens":5}}`,
];

test("claude stream maps to text/tool events + usage + cost + session", () => {
  const ev: AgentEvent[] = [];
  const r = parseCliLines("claude", CLAUDE, (e) => ev.push(e));
  const text = ev.filter((e) => e.type === "text").map((e: any) => e.text).join("");
  expect(text).toBe("hello done");
  expect(ev.some((e) => e.type === "tool-start" && (e as any).name === "read_file")).toBe(true);
  expect(ev.some((e) => e.type === "tool-end" && (e as any).id === "tu1" && (e as any).ok)).toBe(true);
  expect(r.usage).toEqual({ inputTokens: 8861, outputTokens: 4 });
  expect(r.costUSD).toBe(0.19);
  expect(r.sessionId).toBe("sess-abc");
  expect(r.rates?.[0]).toMatchObject({ utilization: 0.81, type: "seven_day" }); // quota snapshot captured
});

test("partial stream_event deltas stream text once (no double with the trailing complete message)", () => {
  const ev: AgentEvent[] = [];
  const lines = [
    `{"type":"system","subtype":"init","session_id":"s1","model":"claude-opus-4-8"}`,
    `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}}`,
    `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}}`,
    // the trailing complete assistant message repeats the full text — must NOT re-emit
    `{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}],"usage":{"input_tokens":3,"output_tokens":1}}}`,
    `{"type":"result","subtype":"success","is_error":false,"result":"Hello","usage":{"input_tokens":3,"output_tokens":1}}`,
  ];
  const r = parseCliLines("claude", lines, (e) => ev.push(e));
  const text = ev.filter((e) => e.type === "text").map((e: any) => e.text).join("");
  expect(text).toBe("Hello"); // streamed once, not "HelloHello"
  expect(ev.filter((e) => e.type === "text").length).toBe(2); // two deltas, no trailing duplicate
  expect(r.usage).toEqual({ inputTokens: 3, outputTokens: 1 });
});

test("buildCliArgs streams claude token-by-token (--include-partial-messages)", () => {
  expect(buildCliArgs("claude", "do it", {})).toContain("--include-partial-messages");
});

test("status-only rate_limit_event (no utilization number) is still captured", () => {
  // The real claude CLI usually emits status + resetsAt but NO utilization.
  const lines = [
    `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1780830600,"rateLimitType":"five_hour"}}`,
    `{"type":"result","subtype":"success","is_error":false,"result":"ok","usage":{"input_tokens":5,"output_tokens":1}}`,
  ];
  const r = parseCliLines("claude", lines, () => {});
  expect(r.rates?.[0]).toMatchObject({ status: "allowed", type: "five_hour", resetsAt: 1780830600 });
  expect(r.rates?.[0]?.utilization).toBeUndefined();
});

test("codex stream maps agent_message + tool item + usage + thread id", () => {
  const ev: AgentEvent[] = [];
  const r = parseCliLines("codex", CODEX, (e) => ev.push(e));
  expect(ev.filter((e) => e.type === "text").map((e: any) => e.text).join("")).toBe("hi there");
  expect(ev.some((e) => e.type === "tool-start" && (e as any).name === "command_execution")).toBe(true);
  expect(r.usage).toEqual({ inputTokens: 18787, outputTokens: 5 });
  expect(r.sessionId).toBe("th-1");
  expect(r.costUSD).toBeUndefined(); // codex doesn't report cost
});

test("non-JSON noise lines are ignored", () => {
  const ev: AgentEvent[] = [];
  const r = parseCliLines("claude", ["not json", "", ...CLAUDE, "trailing garbage"], (e) => ev.push(e));
  expect(r.usage.inputTokens).toBe(8861); // still parsed the real events
});

test("buildCliArgs uses each binary's stream-json flags", () => {
  const c = buildCliArgs("claude", "do it", {});
  expect(c).toContain("--output-format");
  expect(c).toContain("stream-json");
  expect(c.includes("-p")).toBe(true);

  const x = buildCliArgs("codex", "do it", {});
  expect(x[0]).toBe("exec");
  expect(x).toContain("--json");
  expect(x).toContain("--skip-git-repo-check");
  expect(x).toContain("--ignore-user-config");
  expect(x).toContain("--sandbox");
  expect(x).toContain("workspace-write");
  expect(x).toContain("approval_policy=\"never\"");
  expect(x).not.toContain("--ask-for-approval");
  expect(x).not.toContain("--full-auto");

  // autoApprove flips the permission/sandbox flag
  expect(buildCliArgs("claude", "x", { autoApprove: true })).toContain("bypassPermissions");
  expect(buildCliArgs("codex", "x", { autoApprove: true })).toContain("--dangerously-bypass-approvals-and-sandbox");
  // session resume threads through
  expect(buildCliArgs("claude", "x", { sessionId: "s9" })).toContain("s9");
  // out-of-workspace allowances (paste temp dirs, linked-worktree git dir)
  // extend claude's sandbox via --add-dir; codex ignores them (reads are open
  // in its workspace-write sandbox)
  const withDirs = buildCliArgs("claude", "x", { addDirs: ["/tmp/gearbox-paste-a", "/tmp/gearbox-paste-b"] });
  expect(withDirs.filter((a) => a === "--add-dir").length).toBe(2);
  expect(withDirs).toContain("/tmp/gearbox-paste-a");
  expect(buildCliArgs("codex", "x", { addDirs: ["/tmp/gearbox-paste-a"] })).not.toContain("--add-dir");
  // headless claude can't prompt, so read-only git verbs are pre-approved...
  const allowed = buildCliArgs("claude", "x", {}).join(" ");
  expect(allowed).toContain("--allowedTools");
  expect(allowed).toContain("Bash(git status:*)");
  // ...but the MUTATING `worktree` is NOT silently granted — it goes through the
  // bridge prompt (its add/remove write outside the repo)
  expect(allowed).not.toContain("Bash(git worktree:*)");
  // ...and not in plan/read-only mode or under yolo (bypassPermissions covers it)
  expect(buildCliArgs("claude", "x", { readOnly: true })).not.toContain("--allowedTools");
  expect(buildCliArgs("claude", "x", { autoApprove: true })).not.toContain("--allowedTools");
  expect(buildCliArgs("codex", "x", {})).not.toContain("--allowedTools");
  // a known repoRoot also emits exact `git -C <root> …` rules, since models
  // prefix `-C <repo>` for explicitness and that defeats the plain prefix match
  const withRoot = buildCliArgs("claude", "x", { repoRoot: "/Users/me/proj" }).join(" ");
  expect(withRoot).toContain("Bash(git -C /Users/me/proj status:*)");
  // a root with spaces/commas/colons can't be expressed in the rule grammar —
  // skip it cleanly rather than emit a malformed rule (prompt nudge covers it)
  const spaced = buildCliArgs("claude", "x", { repoRoot: "/Users/me/my proj" }).join(" ");
  expect(spaced).not.toContain("-C /Users/me/my proj");
  const coloned = buildCliArgs("claude", "x", { repoRoot: "/Users/me/pr:oj" }).join(" ");
  expect(coloned).not.toContain("-C /Users/me/pr:oj");
});

test("buildCliArgs bridge mode wires the interactive permission control protocol", () => {
  const b = buildCliArgs("claude", "MY PROMPT", { bridge: true });
  // the prompt is delivered on stdin as stream-json, NOT as the positional arg
  expect(b).not.toContain("MY PROMPT");
  expect(b).toContain("--input-format");
  expect(b).toContain("stream-json");
  expect(b).toContain("--permission-prompt-tool");
  expect(b).toContain("stdio");
  // still acceptEdits + pre-grants so safe ops skip the prompt
  expect(b).toContain("acceptEdits");
  expect(b.join(" ")).toContain("Bash(git status:*)");
  // non-bridge keeps the positional prompt and no stdin protocol
  const nb = buildCliArgs("claude", "MY PROMPT", {});
  expect(nb).toContain("MY PROMPT");
  expect(nb).not.toContain("--permission-prompt-tool");
  // Full claude ids pass through UNREDUCED — the family alias ("haiku") would
  // let the CLI substitute its own default version, breaking the routed promise.
  expect(buildCliArgs("claude", "x", { modelId: "claude-haiku-4-5" })).toContain("claude-haiku-4-5");
  expect(buildCliArgs("claude", "x", { modelId: "claude-opus-4-8" })).toContain("claude-opus-4-8");
  // Non-full ids still fall back to the family alias the CLI understands.
  expect(buildCliArgs("claude", "x", { modelId: "opus-4.8" })).toContain("opus");
  expect(buildCliArgs("codex", "x", { modelId: "gpt-5.5" })).toContain("gpt-5.5");
  expect(buildCliArgs("codex", "x", { effort: "xhigh" })).toContain('model_reasoning_effort="xhigh"');

  // `codex exec resume` rejects --sandbox/--model/--dangerously-* outright
  // ("unexpected argument '--sandbox'") — on resume everything rides as -c
  // config overrides, which both subcommands accept.
  const r = buildCliArgs("codex", "x", { sessionId: "s1", modelId: "gpt-5.5", autoApprove: false });
  expect(r.slice(0, 3)).toEqual(["exec", "resume", "s1"]);
  expect(r).not.toContain("--sandbox");
  expect(r).not.toContain("--model");
  expect(r).toContain('sandbox_mode="workspace-write"');
  expect(r).toContain('model="gpt-5.5"');
  expect(r).toContain('approval_policy="never"');
  const ry = buildCliArgs("codex", "x", { sessionId: "s1", autoApprove: true });
  expect(ry).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(ry).toContain('sandbox_mode="danger-full-access"');
  const rr = buildCliArgs("codex", "x", { sessionId: "s1", readOnly: true });
  expect(rr).not.toContain("--sandbox");
  expect(rr).toContain('sandbox_mode="read-only"');
});

// A fresh conversation (/clear) or a resumed session clears cliSessionRef to
// undefined, so the next CLI turn must NOT ask the vendor binary to --resume the
// conversation the user just cleared. This pins the downstream contract that the
// App-side ref reset relies on: no session id → no resume flag.
test("buildCliArgs omits the resume flag when there is no session id", () => {
  const c = buildCliArgs("claude", "fresh start", { sessionId: undefined });
  expect(c).not.toContain("--resume");

  const x = buildCliArgs("codex", "fresh start", { sessionId: undefined });
  expect(x).not.toContain("resume");

  // And it DOES resume when a session id is present (the non-cleared path).
  expect(buildCliArgs("claude", "x", { sessionId: "s9" })).toContain("--resume");
  expect(buildCliArgs("codex", "x", { sessionId: "th-1" })).toContain("resume");
  // codex: `resume <ID>` MUST immediately follow `exec` (it was appended after the
  // flags, so it was eaten as a prompt arg and resume silently never worked).
  const cx = buildCliArgs("codex", "hello", { sessionId: "th-1" });
  expect(cx.slice(0, 3)).toEqual(["exec", "resume", "th-1"]);
  expect(cx[cx.length - 1]).toBe("hello"); // prompt still last
});

test("runCliTask surfaces stderr when a CLI exits without JSON output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gearbox-fake-codex-"));
  const bin = join(dir, "codex-fake");
  writeFileSync(bin, "#!/bin/sh\necho 'boom from stderr' >&2\nexit 7\n");
  chmodSync(bin, 0o755);
  const ev: AgentEvent[] = [];
  try {
    await runCliTask({ binary: bin, prompt: "x", messages: [], onEvent: (e) => ev.push(e) });
    expect(ev.some((e) => e.type === "error" && e.message.includes("boom from stderr"))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCliTask turns Codex expired-session stderr into an account-specific relogin hint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gearbox-fake-codex-"));
  const bin = join(dir, "codex-fake");
  writeFileSync(bin, "#!/bin/sh\necho 'ERROR Failed to refresh token: app_session_terminated. Your session has ended. Please log in again.' >&2\nexit 1\n");
  chmodSync(bin, 0o755);
  const ev: AgentEvent[] = [];
  try {
    await runCliTask({
      binary: bin,
      prompt: "x",
      messages: [],
      onEvent: (e) => ev.push(e),
      accountLabel: "ChatGPT (maitree) · subscription",
      reloginCommand: "/account add codex maitree",
    });
    const msg = ev.find((e) => e.type === "error")?.message ?? "";
    expect(msg).toContain("Codex session expired for ChatGPT (maitree) · subscription");
    expect(msg).toContain("/account add codex maitree");
    expect(msg).not.toContain("Failed to refresh token");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import { formatAskUserQuestion } from "../src/agent/cli-backend.ts";

test("formatAskUserQuestion renders the question and labeled options", () => {
  const out = formatAskUserQuestion({
    questions: [
      { question: "Which provider?", options: [{ label: "Anthropic", description: "Claude" }, { label: "OpenAI" }] },
    ],
  });
  expect(out).toContain("Which provider?");
  expect(out).toContain("1. **Anthropic** — Claude");
  expect(out).toContain("2. **OpenAI**");
  expect(out).toContain("Over to you");
  expect(out).toContain("Reply with");
  expect(out).toContain("your choice");
});

test("formatAskUserQuestion returns empty string when there are no questions", () => {
  expect(formatAskUserQuestion({})).toBe("");
  expect(formatAskUserQuestion(null)).toBe("");
});

test("captures the model the claude stream reports (for the status bar)", () => {
  const lines = [
    '{"type":"system","subtype":"init","session_id":"s1","model":"claude-sonnet-4-6"}',
    '{"type":"assistant","message":{"model":"claude-sonnet-4-6","content":[{"type":"text","text":"hi"}]}}',
    '{"type":"result","usage":{"input_tokens":10,"output_tokens":5}}',
  ];
  const r = parseCliLines("claude", lines, () => {});
  expect(r.model).toBe("claude-sonnet-4-6");
});

// ── worktrees: codex's sandbox must include the main .git dir ────────────────
import { worktreeGitRoots } from "../src/agent/cli-backend.ts";
import { mkdtempSync as mkTmp, writeFileSync as writeF, mkdirSync as mkDir } from "node:fs";
import { tmpdir as osTmp } from "node:os";
import { join as pjoin } from "node:path";

test("worktreeGitRoots resolves the main .git for a worktree, [] otherwise", () => {
  const main = mkTmp(pjoin(osTmp(), "gbx-wt-"));
  mkDir(pjoin(main, ".git", "worktrees", "cowboy"), { recursive: true });
  const wt = pjoin(main, "tabs", "cowboy");
  mkDir(wt, { recursive: true });
  writeF(pjoin(wt, ".git"), `gitdir: ${pjoin(main, ".git", "worktrees", "cowboy")}\n`);
  expect(worktreeGitRoots(wt)).toEqual([pjoin(main, ".git")]);
  // a normal repo (.git is a directory) and a non-repo both yield nothing
  expect(worktreeGitRoots(main)).toEqual([]);
  expect(worktreeGitRoots(osTmp())).toEqual([]);
});

test("codex args include the worktree's git dir as a writable sandbox root", () => {
  const w = buildCliArgs("codex", "x", { writableRoots: ["/repo/.git"] });
  expect(w.join(" ")).toContain('sandbox_workspace_write.writable_roots=["/repo/.git"]');
  // resume path carries it too (as -c, which exec resume accepts)
  const r = buildCliArgs("codex", "x", { sessionId: "s1", writableRoots: ["/repo/.git"] });
  expect(r.join(" ")).toContain('writable_roots=["/repo/.git"]');
  // yolo (full bypass) and read-only don't need it
  expect(buildCliArgs("codex", "x", { autoApprove: true, writableRoots: ["/repo/.git"] }).join(" ")).not.toContain("writable_roots");
});

// ── seat switch: the conversation must survive a fresh vendor session ────────
import { handoffDigest } from "../src/agent/cli-backend.ts";

test("handoffDigest carries the conversation text, newest-first under the budget", () => {
  const messages = [
    { role: "user", content: "design the parser" },
    { role: "assistant", content: [{ type: "text", text: "Parser design: use a recursive descent approach." }, { type: "tool-call", toolCallId: "t1", toolName: "read_file", input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", output: "file body" }] },
    { role: "user", content: "now add error recovery" },
  ] as any;
  const d = handoffDigest(messages);
  expect(d).toContain("<conversation-so-far>");
  expect(d).toContain("User: design the parser");
  expect(d).toContain("recursive descent"); // assistant text kept
  expect(d).not.toContain("file body"); // tool results don't translate — dropped
  expect(d).toContain("continue it");
  // budget: newest survives, oldest elided with an honest marker
  const many = Array.from({ length: 100 }, (_, i) => ({ role: "user", content: `message number ${i} ` + "x".repeat(400) })) as any;
  const small = handoffDigest(many, 4000);
  expect(small).toContain("message number 99");
  expect(small).not.toContain("message number 0 ");
  expect(small).toMatch(/\d+ earlier messages elided/);
  // empty ledger → no digest block at all
  expect(handoffDigest([] as any)).toBe("");
});
