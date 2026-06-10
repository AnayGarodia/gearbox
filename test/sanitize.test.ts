import { test, expect } from "bun:test";
import type { ModelMessage } from "ai";
import { sanitizeForProvider, sanitizeWithMap } from "../src/context/sanitize.ts";

const user = (text: string): ModelMessage => ({ role: "user", content: text });
const assistant = (text: string): ModelMessage => ({ role: "assistant", content: text });

test("consecutive user messages merge into one (the dangling-user repair)", () => {
  const out = sanitizeForProvider([user("first prompt"), user("second prompt")]);
  expect(out).toHaveLength(1);
  expect(out[0]).toEqual({ role: "user", content: "first prompt\n\nsecond prompt" });
});

test("a dropped empty assistant between users still triggers the merge", () => {
  const out = sanitizeForProvider([user("a"), { role: "assistant", content: [] } as any, user("b")]);
  expect(out).toEqual([{ role: "user", content: "a\n\nb" }]);
});

test("user messages with part arrays merge by concatenating parts", () => {
  const a: ModelMessage = { role: "user", content: [{ type: "text", text: "look at this" }, { type: "image", image: "data:..." } as any] };
  const out = sanitizeForProvider([a, user("and this")]);
  expect(out).toHaveLength(1);
  const parts = (out[0] as any).content;
  expect(parts.map((p: any) => p.type)).toEqual(["text", "image", "text"]);
});

test("an unpaired tool-call gets a synthesized interrupted tool-result", () => {
  const msgs: ModelMessage[] = [
    user("do it"),
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "t1", toolName: "run_shell", input: { command: "ls" } }] } as any,
    user("why did you stop?"),
  ];
  const out = sanitizeForProvider(msgs);
  expect(out).toHaveLength(4);
  expect((out[2] as any).role).toBe("tool");
  expect((out[2] as any).content).toEqual([
    { type: "tool-result", toolCallId: "t1", toolName: "run_shell", output: { type: "text", value: "[tool execution was interrupted]" } },
  ]);
});

test("a trailing unpaired tool-call (end of history) is also paired", () => {
  const msgs: ModelMessage[] = [
    user("go"),
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "t9", toolName: "read_file", input: { path: "x" } }] } as any,
  ];
  const out = sanitizeForProvider(msgs);
  expect((out[out.length - 1] as any).role).toBe("tool");
  expect((out[out.length - 1] as any).content[0].toolCallId).toBe("t9");
});

test("partially answered tool-calls synthesize only the missing results", () => {
  const msgs: ModelMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "a", toolName: "read_file", input: {} },
        { type: "tool-call", toolCallId: "b", toolName: "search", input: {} },
      ],
    } as any,
    { role: "tool", content: [{ type: "tool-result", toolCallId: "a", toolName: "read_file", output: { type: "text", value: "ok" } }] } as any,
    user("next"),
  ];
  const out = sanitizeForProvider(msgs);
  const tools = out.filter((m) => (m as any).role === "tool");
  expect(tools).toHaveLength(2);
  expect((tools[1] as any).content[0]).toMatchObject({ toolCallId: "b", output: { value: "[tool execution was interrupted]" } });
});

test("orphaned tool-results (no preceding tool-call) are dropped", () => {
  const msgs: ModelMessage[] = [
    user("hi"),
    { role: "tool", content: [{ type: "tool-result", toolCallId: "ghost", toolName: "search", output: { type: "text", value: "x" } }] } as any,
    assistant("hello"),
  ];
  const out = sanitizeForProvider(msgs);
  expect(out.map((m) => (m as any).role)).toEqual(["user", "assistant"]);
});

test("empty-content messages are dropped", () => {
  const out = sanitizeForProvider([user(""), assistant("hi"), { role: "assistant", content: [] } as any, user("ok")]);
  expect(out.map((m) => (m as any).role)).toEqual(["assistant", "user"]);
});

test("reasoning parts and providerOptions/providerMetadata residue are stripped", () => {
  const msgs: ModelMessage[] = [
    {
      role: "assistant",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      content: [
        { type: "reasoning", text: "thinking...", providerOptions: { anthropic: { signature: "sig" } } },
        { type: "text", text: "the answer", providerMetadata: { anthropic: { foo: 1 } } },
      ],
    } as any,
  ];
  const out = sanitizeForProvider(msgs);
  expect(out).toHaveLength(1);
  const m = out[0] as any;
  expect(m.providerOptions).toBeUndefined();
  expect(m.content).toEqual([{ type: "text", text: "the answer" }]);
});

test("an assistant reduced to ONLY reasoning is dropped entirely", () => {
  const msgs: ModelMessage[] = [user("q"), { role: "assistant", content: [{ type: "reasoning", text: "hmm" }] } as any, user("q2")];
  const out = sanitizeForProvider(msgs);
  expect(out).toEqual([{ role: "user", content: "q\n\nq2" }]);
});

test("healthy history passes through with object identity preserved", () => {
  const msgs: ModelMessage[] = [user("a"), assistant("b"), user("c")];
  const out = sanitizeForProvider(msgs);
  expect(out).toHaveLength(3);
  for (let i = 0; i < 3; i++) expect(out[i]).toBe(msgs[i]!);
});

test("idempotent: sanitizing twice equals sanitizing once", () => {
  const messy: ModelMessage[] = [
    user(""),
    user("a"),
    user("b"),
    { role: "assistant", content: [{ type: "reasoning", text: "r" }, { type: "tool-call", toolCallId: "t", toolName: "glob", input: {} }] } as any,
    user("again"),
  ];
  const once = sanitizeForProvider(messy);
  const twice = sanitizeForProvider(once);
  expect(twice).toEqual(once);
});

test("never throws on garbage shapes — passes the salvageable through", () => {
  const garbage: any[] = [null, 42, { content: "no role" }, { role: "user", content: "real" }, { role: "tool", content: "not-an-array" }];
  const out = sanitizeForProvider(garbage as ModelMessage[]);
  expect(out).toEqual([{ role: "user", content: "real" }]);
});

test("sourceIndex maps output back to original positions for cacheBreak remap", () => {
  const msgs: ModelMessage[] = [
    user("a"),
    user("b"), // merges into index 0's slot
    assistant("ok"),
    user("c"),
  ];
  const { messages, sourceIndex } = sanitizeWithMap(msgs);
  expect(messages).toHaveLength(3);
  expect(sourceIndex).toEqual([0, 2, 3]);
});
