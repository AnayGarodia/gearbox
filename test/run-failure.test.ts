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

import { cleanError } from "../src/agent/run.ts";

test("cleanError surfaces the response-body reason behind a bare HTTP status", () => {
  // The AI SDK's APICallError on a 422: message is just the status phrase, the
  // real reason lives in responseBody (the case from the azure-foundry grok-4.3
  // 'Unprocessable Entity' report).
  const err: any = {
    statusCode: 422,
    message: "Unprocessable Entity",
    responseBody: JSON.stringify({ error: { message: "model 'grok-4.3' does not support tool use", code: "unsupported" } }),
  };
  const out = cleanError(err);
  expect(out).toContain("Unprocessable Entity");
  expect(out).toContain("does not support tool use");

  // Object responseBody works too.
  expect(cleanError({ message: "Bad Request", responseBody: { error: { message: "temperature must be <= 1" } } }))
    .toBe("Bad Request — temperature must be <= 1");

  // No duplication when the body reason already equals/contains the top line.
  expect(cleanError({ message: "boom", responseBody: "boom" })).toBe("boom");

  // Plain message with no body is unchanged; empty error degrades gracefully.
  expect(cleanError({ message: "invalid x-api-key" })).toBe("invalid x-api-key");
  expect(cleanError({})).toBe("request failed");

  // Multi-line bodies collapse to the first line and overall length is capped.
  expect(cleanError({ message: "Bad Request", responseBody: "first line\nsecond line" })).toBe("Bad Request — first line");
});
