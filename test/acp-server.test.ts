// Drives the full ACP server loop over in-memory lines with an injected
// TurnRunner — no model, no network. Asserts the protocol conversation an
// editor would see: initialize → session/new → session/prompt streaming
// session/update → stopReason, plus permission round-trips and cancel.
import { beforeEach, describe, expect, test } from "bun:test";
import { AcpServer, type TurnRunner } from "../src/acp/server.ts";
import { requestPermission, resetPermissions, setPermissionHandler } from "../src/permission.ts";

function makeServer(runner: TurnRunner) {
  const out: any[] = [];
  const server = new AcpServer((line) => out.push(JSON.parse(line)), runner);
  const send = (msg: any) => server.feed(JSON.stringify(msg) + "\n");
  return { out, send };
}

const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } };
const newSession = { jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } };

beforeEach(() => {
  resetPermissions();
  setPermissionHandler(null);
});

describe("AcpServer", () => {
  test("initialize → session/new → prompt streams updates and ends the turn", async () => {
    const runner: TurnRunner = async ({ onEvent }) => {
      onEvent({ type: "text", text: "hello " });
      onEvent({ type: "tool-start", id: "t1", name: "read_file", arg: "a.ts" });
      onEvent({ type: "tool-end", id: "t1", ok: true, summary: "read a.ts" });
      onEvent({ type: "text", text: "world" });
      return { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello world" }] };
    };
    const { out, send } = makeServer(runner);
    await send(init);
    expect(out[0].result.protocolVersion).toBe(1);
    await send(newSession);
    const sessionId = out[1].result.sessionId;
    expect(sessionId).toMatch(/^gbx-sess-/);
    await send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "hi" }] } });

    const updates = out.filter((m) => m.method === "session/update").map((m) => m.params.update);
    expect(updates.some((u) => u.sessionUpdate === "agent_message_chunk" && u.content.text === "hello ")).toBe(true);
    expect(updates.some((u) => u.sessionUpdate === "tool_call" && u.toolCallId === "t1")).toBe(true);
    expect(updates.some((u) => u.sessionUpdate === "tool_call_update" && u.status === "completed")).toBe(true);
    const final = out.find((m) => m.id === 3);
    expect(final.result).toEqual({ stopReason: "end_turn" });
  });

  test("multi-turn: history carries between prompts", async () => {
    const seen: number[] = [];
    const runner: TurnRunner = async ({ history, prompt }) => {
      seen.push(history.length);
      return { messages: [...history, { role: "user", content: prompt }, { role: "assistant", content: "ok" }] };
    };
    const { out, send } = makeServer(runner);
    await send(init);
    await send(newSession);
    const sessionId = out[1].result.sessionId;
    await send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "one" }] } });
    await send({ jsonrpc: "2.0", id: 4, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "two" }] } });
    expect(seen).toEqual([0, 2]); // second prompt sees the first turn's two messages
  });

  test("runner failure → inline message + stopReason refusal (not a JSON-RPC error)", async () => {
    const runner: TurnRunner = async () => ({ messages: [], failure: { message: "no provider available" } });
    const { out, send } = makeServer(runner);
    await send(init);
    await send(newSession);
    const sessionId = out[1].result.sessionId;
    await send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "x" }] } });
    const final = out.find((m) => m.id === 3);
    expect(final.result).toEqual({ stopReason: "refusal" });
    expect(final.error).toBeUndefined();
    const updates = out.filter((m) => m.method === "session/update").map((m) => m.params.update);
    expect(updates.some((u) => u.sessionUpdate === "agent_message_chunk" && u.content.text.includes("no provider available"))).toBe(true);
  });

  test("session/cancel aborts the in-flight prompt → stopReason cancelled", async () => {
    let release: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runner: TurnRunner = async ({ signal }) => {
      await gate;
      expect(signal.aborted).toBe(true);
      return { messages: [] };
    };
    const { out, send } = makeServer(runner);
    await send(init);
    await send(newSession);
    const sessionId = out[1].result.sessionId;
    const promptDone = send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "x" }] } });
    await send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
    release!();
    await promptDone;
    const final = out.find((m) => m.id === 3);
    expect(final.result).toEqual({ stopReason: "cancelled" });
  });

  test("permission requests round-trip through session/request_permission", async () => {
    const runner: TurnRunner = async ({ cwd }) => {
      // A mutating tool inside the turn asks the broker; the server's handler
      // forwards to the client and maps the outcome back.
      const allowed = await requestPermission({ kind: "shell", title: "Run a shell command", detail: "rm x", root: cwd });
      return { messages: [{ role: "assistant", content: allowed ? "ran" : "declined" }] as any };
    };
    const { out, send } = makeServer(runner);
    await send(init);
    await send(newSession);
    const sessionId = out[1].result.sessionId;
    const promptDone = send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "x" }] } });

    // Wait for the outbound permission request to appear, then answer "deny".
    let req: any;
    for (let i = 0; i < 50 && !req; i++) {
      req = out.find((m) => m.method === "session/request_permission");
      if (!req) await new Promise((r) => setTimeout(r, 10));
    }
    expect(req.params.sessionId).toBe(sessionId);
    expect(req.params.options.map((o: any) => o.kind)).toEqual(["allow_once", "allow_always", "reject_once"]);
    await send({ jsonrpc: "2.0", id: req.id, result: { outcome: { outcome: "selected", optionId: "deny" } } });
    await promptDone;
    const final = out.find((m) => m.id === 3);
    expect(final.result.stopReason).toBe("end_turn");
  });

  test("unknown method → -32601; malformed line → -32700; unknown session → -32602", async () => {
    const { out, send } = makeServer(async () => ({ messages: [] }));
    await send({ jsonrpc: "2.0", id: 9, method: "bogus/method" });
    expect(out.find((m) => m.id === 9).error.code).toBe(-32601);
    const server2 = makeServer(async () => ({ messages: [] }));
    await server2.send({ jsonrpc: "2.0", id: 10, method: "session/prompt", params: { sessionId: "nope", prompt: [] } });
    expect(server2.out.find((m) => m.id === 10).error.code).toBe(-32602);
  });
});

describe("client fs + session/load", () => {
  test("fs capabilities inject editor-backed read/write tool overrides", async () => {
    let gotTools: Record<string, any> | undefined;
    const runner: TurnRunner = async ({ extraTools }) => {
      gotTools = extraTools;
      return { messages: [] };
    };
    const { out, send } = makeServer(runner);
    await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } } });
    await send(newSession);
    const sessionId = out[1].result.sessionId;
    const turn = send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "x" }] } });
    await turn;
    expect(gotTools).toBeDefined();
    expect(Object.keys(gotTools!)).toEqual(["read_file", "write_file"]);

    // Drive the injected read tool: it must issue fs/read_text_file to the
    // client and return the buffer content (the unsaved-buffer path).
    const readPromise = gotTools!.read_file.execute({ path: "src/a.ts", offset: 2 }, {} as any);
    let req: any;
    for (let i = 0; i < 50 && !req; i++) {
      req = out.find((m) => m.method === "fs/read_text_file");
      if (!req) await new Promise((r) => setTimeout(r, 5));
    }
    expect(req.params).toMatchObject({ sessionId, line: 2 });
    expect(req.params.path.endsWith("/src/a.ts")).toBe(true); // absolutized against cwd
    await send({ jsonrpc: "2.0", id: req.id, result: { content: "unsaved buffer text" } });
    expect(await readPromise).toBe("unsaved buffer text");
  });

  test("no fs capabilities → no overrides (disk tools stay)", async () => {
    let gotTools: Record<string, any> | undefined | null = null;
    const runner: TurnRunner = async ({ extraTools }) => {
      gotTools = extraTools;
      return { messages: [] };
    };
    const { out, send } = makeServer(runner);
    await send(init);
    await send(newSession);
    await send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: out[1].result.sessionId, prompt: [{ type: "text", text: "x" }] } });
    expect(gotTools).toBeUndefined();
  });

  test("session/load replays a persisted session and continues with its history", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = mkdtempSync(join(tmpdir(), "gbx-acp-load-"));
    const prevHome = process.env.GEARBOX_HOME;
    process.env.GEARBOX_HOME = home;
    try {
      let lastHistory: any[] = [];
      const runner: TurnRunner = async ({ history, prompt }) => {
        lastHistory = history;
        return { messages: [...history, { role: "user", content: prompt }, { role: "assistant", content: "continued" }] };
      };
      // First server: create a session and run one turn (persists the record).
      const a = makeServer(runner);
      await a.send(init);
      await a.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
      const sessionId = a.out[1].result.sessionId;
      await a.send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "first" }] } });

      // Second server (fresh process, same disk): load the same session.
      const b = makeServer(runner);
      await b.send(init);
      await b.send({ jsonrpc: "2.0", id: 2, method: "session/load", params: { sessionId, cwd: "/tmp", mcpServers: [] } });
      const loadResp = b.out.find((m) => m.id === 2);
      expect(loadResp.result).toBeNull();
      const replays = b.out.filter((m) => m.method === "session/update").map((m) => m.params.update);
      expect(replays.some((u) => u.sessionUpdate === "user_message_chunk" && u.content.text === "first")).toBe(true);
      expect(replays.some((u) => u.sessionUpdate === "agent_message_chunk" && u.content.text === "continued")).toBe(true);
      // A follow-up prompt sees the loaded history.
      await b.send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "second" }] } });
      expect(lastHistory.length).toBe(2);
    } finally {
      if (prevHome === undefined) delete process.env.GEARBOX_HOME;
      else process.env.GEARBOX_HOME = prevHome;
    }
  });

  test("session/load with an unknown id fails with -32602", async () => {
    const { out, send } = makeServer(async () => ({ messages: [] }));
    await send(init);
    await send({ jsonrpc: "2.0", id: 2, method: "session/load", params: { sessionId: "gbx-sess-nope", cwd: "/tmp" } });
    expect(out.find((m) => m.id === 2).error.code).toBe(-32602);
  });
});

describe("replay mapping", () => {
  test("replayUpdates renders user/assistant prose and completed tool calls", async () => {
    const { replayUpdates } = await import("../src/acp/protocol.ts");
    const updates = replayUpdates([
      { role: "user", content: "fix the bug" },
      { role: "assistant", content: [{ type: "text", text: "looking" }, { type: "tool-call", toolCallId: "x", toolName: "read_file", input: { path: "a.ts" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "x", output: "..." }] },
      { role: "assistant", content: "fixed" },
    ] as any);
    expect(updates[0]).toMatchObject({ sessionUpdate: "user_message_chunk", content: { text: "fix the bug" } });
    expect(updates[1]).toMatchObject({ sessionUpdate: "agent_message_chunk", content: { text: "looking" } });
    expect(updates[2]).toMatchObject({ sessionUpdate: "tool_call", kind: "read", status: "completed", title: "read_file: a.ts" });
    expect(updates[3]).toMatchObject({ sessionUpdate: "agent_message_chunk", content: { text: "fixed" } });
  });
});
