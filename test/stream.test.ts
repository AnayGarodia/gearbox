import { test, expect } from "bun:test";
import { FieldStreamer, readField, runTask } from "../src/agent/run.ts";
import { createTools } from "../src/tools.ts";
import { resetPermissions, setPermissionHandler, setYolo } from "../src/permission.ts";
import type { AgentEvent } from "../src/agent/events.ts";

// Feed a JSON object's text through the streamer in arbitrary chunk sizes and
// confirm the decoded content field equals the original — including escapes that
// land across chunk boundaries (the tricky case for live tool-input streaming).
function decodeInChunks(json: string, field: string, size: number): string {
  const fs = new FieldStreamer(field);
  let out = "";
  for (let i = 0; i < json.length; i += size) out += fs.push(json.slice(i, i + size));
  return out;
}

test("FieldStreamer decodes a content field across every chunk size", () => {
  const content = 'line one\n\tindented "quoted" \\ backslash\nline three\n';
  const json = JSON.stringify({ path: "x.py", content });
  for (const size of [1, 2, 3, 5, 8, 13, 1000]) {
    expect(decodeInChunks(json, "content", size)).toBe(content);
  }
});

test("FieldStreamer yields nothing until its field appears, then only that field", () => {
  const json = JSON.stringify({ path: "a/b.ts", find: "old", replace: "new\nvalue" });
  expect(decodeInChunks(json, "replace", 4)).toBe("new\nvalue");
  // a field that isn't present stays empty
  expect(decodeInChunks(json, "content", 4)).toBe("");
});

test("FieldStreamer stops at the closing quote (ignores later fields)", () => {
  const json = JSON.stringify({ content: "abc", path: "after.py" });
  expect(decodeInChunks(json, "content", 2)).toBe("abc");
});

test("readField extracts the short head label from a partial buffer", () => {
  expect(readField('{"path":"src/cli.tsx","content":"', "path")).toBe("src/cli.tsx");
  expect(readField('{"command":"bun test"', "command")).toBe("bun test");
  expect(readField('{"pa', "path")).toBeNull();
});

test("partial unicode escape is held back until complete", () => {
  const content = "snow☃man";
  const json = JSON.stringify({ content });
  // chunk size 1 forces \uXXXX to arrive one hex digit at a time
  expect(decodeInChunks(json, "content", 1)).toBe(content);
});

// Feed runTask a simulated SDK fullStream (the exact part shape Anthropic emits:
// tool-input-start → tool-input-delta chunks of partial JSON → tool-call →
// tool-result) and confirm it streams the file content out INCREMENTALLY rather
// than in one lump. This is the path the user hit ("all at once").
test("runTask streams write_file content incrementally as input arrives", async () => {
  const content = "import os\nimport sys\n\ndef main():\n    print('hi')\n\nif __name__ == '__main__':\n    main()\n";
  const json = JSON.stringify({ path: "app.py", content });
  // chunk the raw JSON the way input_json_delta would arrive
  const chunks: string[] = [];
  for (let i = 0; i < json.length; i += 7) chunks.push(json.slice(i, i + 7));

  async function* fakeStream() {
    yield { type: "tool-input-start", toolCallId: "t1", toolName: "write_file" };
    for (const c of chunks) yield { type: "tool-input-delta", toolCallId: "t1", inputTextDelta: c };
    yield { type: "tool-call", toolCallId: "t1", toolName: "write_file", input: { path: "app.py", content } };
    yield { type: "tool-result", toolCallId: "t1", output: { summary: "wrote app.py", diff: content.split("\n").map((t) => ({ sign: "+", text: t })) } };
    yield { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 2 } };
  }

  const events: AgentEvent[] = [];
  await runTask({ model: {} as any, messages: [], onEvent: (e) => events.push(e), _stream: fakeStream() });

  const streamDeltas = events.filter((e): e is Extract<AgentEvent, { type: "tool-stream" }> => e.type === "tool-stream" && e.delta != null);
  // Incremental: many small content emits, not one giant blob.
  expect(streamDeltas.length).toBeGreaterThan(3);
  // Reassembling the streamed deltas reproduces the file exactly.
  expect(streamDeltas.map((e) => e.delta).join("")).toBe(content);
  // The head label (path) streamed too, and a tool-start opened the item.
  expect(events.some((e) => e.type === "tool-stream" && e.arg === "app.py")).toBe(true);
  expect(events.some((e) => e.type === "tool-start" && e.id === "t1")).toBe(true);
  expect(events.some((e) => e.type === "tool-end" && e.id === "t1")).toBe(true);
});

test("self-rendering tools (delegate_parallel) emit NO generic tool UI", async () => {
  // delegate/delegate_parallel report their own rich progress via onEvent. The
  // generic tool lifecycle must NOT also render them — that double-rendered the
  // call and stamped a garbage `[object Object]` head from the {tasks:[…]} input.
  const input = { tasks: [{ task: "a" }, { task: "b" }] };
  const json = JSON.stringify(input);
  const chunks: string[] = [];
  for (let i = 0; i < json.length; i += 5) chunks.push(json.slice(i, i + 5));
  async function* fakeStream() {
    yield { type: "tool-input-start", toolCallId: "d1", toolName: "delegate_parallel" };
    for (const c of chunks) yield { type: "tool-input-delta", toolCallId: "d1", inputTextDelta: c };
    yield { type: "tool-call", toolCallId: "d1", toolName: "delegate_parallel", input };
    yield { type: "tool-result", toolCallId: "d1", output: "Ran 2 sub-tasks in parallel" };
    yield { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 2 } };
  }
  const events: AgentEvent[] = [];
  await runTask({ model: {} as any, messages: [], onEvent: (e) => events.push(e), _stream: fakeStream() });
  // No tool-start / tool-stream / tool-end for the delegate call id.
  expect(events.some((e) => "id" in e && (e as any).id === "d1")).toBe(false);
  // And crucially, the garbage head never appears anywhere.
  expect(JSON.stringify(events)).not.toContain("[object Object]");
});

test("a stream error becomes ONE clean line, never the raw error object", async () => {
  // A fat APICallError-like object (the thing that got dumped to the screen).
  const big: any = Object.assign(new Error("Your credit balance is too low to access the Anthropic API."), {
    url: "https://api.anthropic.com/v1/messages",
    statusCode: 400,
    requestBodyValues: { model: "claude-sonnet-4-6", messages: [{}], tools: [{}, {}] },
    responseHeaders: { "anthropic-organization-id": "x" },
  });
  async function* fakeStream() {
    yield { type: "error", error: big };
  }
  const events: AgentEvent[] = [];
  await runTask({ model: {} as any, messages: [], onEvent: (e) => events.push(e), _stream: fakeStream() });
  const err = events.find((e): e is Extract<AgentEvent, { type: "error" }> => e.type === "error");
  expect(err?.message).toBe("Your credit balance is too low to access the Anthropic API.");
  expect(err?.message).not.toContain("requestBodyValues");
  expect(err?.message).not.toContain("statusCode");
});

test("run_shell tool emits live tool-output events", async () => {
  setPermissionHandler(null);
  resetPermissions();
  setYolo(true);
  try {
    const events: AgentEvent[] = [];
    const t = createTools((e) => events.push(e)).run_shell as any;
    const out = await t.execute({ command: "printf live" });
    expect(out).toContain("live");
    expect(events.some((e) => e.type === "tool-output" && e.text.includes("live"))).toBe(true);
  } finally {
    resetPermissions();
    setPermissionHandler(null);
  }
});
