import { test, expect } from "bun:test";
import { runTask } from "../src/agent/run.ts";
import { MODELS } from "../src/providers.ts";

const model = MODELS.find((m) => m.id === "claude-haiku-4-5")!;

// An async iterable that yields an error part then ends, simulating the SDK.
async function* errStream() {
  yield { type: "error", error: { statusCode: 401, message: "invalid x-api-key" } };
}

test("with deferTerminal, runTask returns a structured failure and emits no error event", async () => {
  const events: any[] = [];
  const res = await runTask({
    model, messages: [], onEvent: (e) => events.push(e),
    _stream: errStream(), deferTerminal: true,
  });
  expect(res.failure).toBeTruthy();
  expect(res.failure!.producedOutput).toBe(false);
  expect(res.failure!.raw).toMatchObject({ statusCode: 401 });
  expect(events.find((e) => e.type === "error")).toBeUndefined();
});

test("producedOutput is true when text streamed before the error", async () => {
  async function* mixed() {
    yield { type: "text-delta", text: "hello" };
    yield { type: "error", error: { statusCode: 429, message: "rate limit" } };
  }
  const events: any[] = [];
  const res = await runTask({
    model, messages: [], onEvent: (e) => events.push(e),
    _stream: mixed(), deferTerminal: true,
  });
  expect(res.failure).toBeTruthy();
  expect(res.failure!.producedOutput).toBe(true);
});
