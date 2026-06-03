import { test, expect } from "bun:test";
import { parseCliLines, buildCliArgs } from "../src/agent/cli-backend.ts";
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
  expect(r.rate).toMatchObject({ utilization: 0.81, type: "seven_day" }); // quota snapshot captured
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

  // autoApprove flips the permission/sandbox flag
  expect(buildCliArgs("claude", "x", { autoApprove: true })).toContain("bypassPermissions");
  expect(buildCliArgs("codex", "x", { autoApprove: true })).toContain("--dangerously-bypass-approvals-and-sandbox");
  // session resume threads through
  expect(buildCliArgs("claude", "x", { sessionId: "s9" })).toContain("s9");
});
