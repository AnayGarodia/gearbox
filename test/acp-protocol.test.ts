import { describe, expect, test } from "bun:test";
import {
  decodeLines,
  encodeMessage,
  eventToUpdates,
  newEventMapState,
  outcomeToDecision,
  promptText,
  toolKind,
  initializeResult,
  ACP_PROTOCOL_VERSION,
} from "../src/acp/protocol.ts";

describe("framing", () => {
  test("decodeLines parses complete lines and keeps the partial tail", () => {
    const { messages, rest } = decodeLines('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n{"jsonrpc":"2.0","id":2');
    expect(messages).toHaveLength(1);
    expect((messages[0] as any).method).toBe("initialize");
    expect(rest).toBe('{"jsonrpc":"2.0","id":2');
  });
  test("malformed lines become parseError markers, blank lines are skipped", () => {
    const { messages } = decodeLines("not json\n\n{\"jsonrpc\":\"2.0\"}\n");
    expect(messages).toHaveLength(2);
    expect("parseError" in messages[0]!).toBe(true);
    expect("parseError" in messages[1]!).toBe(false);
  });
  test("encodeMessage emits one newline-terminated compact line", () => {
    const line = encodeMessage({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
  });
});

describe("event mapping", () => {
  test("text → agent_message_chunk", () => {
    const u = eventToUpdates({ type: "text", text: "hi" }, newEventMapState());
    expect(u).toEqual([{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }]);
  });
  test("tool lifecycle: start → in_progress, end → completed with summary", () => {
    const s = newEventMapState();
    const start = eventToUpdates({ type: "tool-start", id: "t1", name: "edit_file", arg: "src/a.ts" }, s);
    expect(start[0]).toMatchObject({ sessionUpdate: "tool_call", toolCallId: "t1", kind: "edit", status: "in_progress", locations: [{ path: "src/a.ts" }] });
    const end = eventToUpdates({ type: "tool-end", id: "t1", ok: true, summary: "edited src/a.ts" }, s);
    expect(end[0]).toMatchObject({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
  });
  test("tool-end failure → failed; unannounced ids are dropped", () => {
    const s = newEventMapState();
    expect(eventToUpdates({ type: "tool-end", id: "ghost", ok: false, summary: "x" }, s)).toEqual([]);
    eventToUpdates({ type: "tool-start", id: "t2", name: "run_shell", arg: "bun test" }, s);
    const end = eventToUpdates({ type: "tool-end", id: "t2", ok: false, summary: "exit 1" }, s);
    expect(end[0]).toMatchObject({ status: "failed" });
  });
  test("tool-output streams as tool_call_update content", () => {
    const s = newEventMapState();
    eventToUpdates({ type: "tool-start", id: "t3", name: "run_shell", arg: "ls" }, s);
    const u = eventToUpdates({ type: "tool-output", id: "t3", stream: "stdout", text: "file.ts\n" }, s);
    expect(u[0]).toMatchObject({ sessionUpdate: "tool_call_update", toolCallId: "t3" });
  });
  test("verification → synthetic execute tool_call pair", () => {
    const u = eventToUpdates({ type: "verification", command: "bun test", ok: true, summary: "passed" }, newEventMapState());
    expect(u).toHaveLength(2);
    expect(u[0]).toMatchObject({ sessionUpdate: "tool_call", kind: "execute", status: "in_progress" });
    expect(u[1]).toMatchObject({ sessionUpdate: "tool_call_update", status: "completed" });
  });
  test("internal events map to nothing", () => {
    const s = newEventMapState();
    expect(eventToUpdates({ type: "phase", label: "thinking" } as any, s)).toEqual([]);
    expect(eventToUpdates({ type: "model-pick", model: "x", provider: "y", reason: "z" } as any, s)).toEqual([]);
    expect(eventToUpdates({ type: "done", usage: { inputTokens: 1, outputTokens: 1 } } as any, s)).toEqual([]);
  });
});

describe("prompt + permissions + init", () => {
  test("promptText flattens text, resource links, and embedded resources", () => {
    const text = promptText([
      { type: "text", text: "fix the bug" },
      { type: "resource_link", uri: "file:///ws/src/a.ts", name: "a.ts" },
      { type: "resource", resource: { uri: "file:///ws/b.ts", text: "const b = 1;" } },
    ]);
    expect(text).toContain("fix the bug");
    expect(text).toContain("@/ws/src/a.ts");
    expect(text).toContain("const b = 1;");
  });
  test("outcomeToDecision maps selections and treats cancelled as deny", () => {
    expect(outcomeToDecision({ outcome: "selected", optionId: "once" })).toBe("once");
    expect(outcomeToDecision({ outcome: "selected", optionId: "always" })).toBe("always");
    expect(outcomeToDecision({ outcome: "selected", optionId: "deny" })).toBe("deny");
    expect(outcomeToDecision({ outcome: "cancelled" })).toBe("deny");
    expect(outcomeToDecision(undefined)).toBe("deny");
  });
  test("toolKind covers the built-in toolset", () => {
    expect(toolKind("read_file")).toBe("read");
    expect(toolKind("edit_file")).toBe("edit");
    expect(toolKind("run_shell")).toBe("execute");
    expect(toolKind("glob")).toBe("search");
    expect(toolKind("web_search")).toBe("fetch");
    expect(toolKind("mcp_github_create_issue")).toBe("other");
  });
  test("initializeResult advertises version 1 and honest capabilities", () => {
    const r = initializeResult("0.11.4") as any;
    expect(r.protocolVersion).toBe(ACP_PROTOCOL_VERSION);
    expect(r.agentCapabilities.loadSession).toBe(false);
    expect(r.agentInfo.name).toBe("gearbox");
    expect(r.authMethods).toEqual([]);
  });
});
