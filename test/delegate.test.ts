import { test, expect, afterEach } from "bun:test";
import { makeDelegateTool } from "../src/agent/delegate.ts";

const origKey = process.env.ANTHROPIC_API_KEY;
afterEach(() => {
  if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = origKey;
});

function makeTool(run: any, events: any[] = []) {
  return makeDelegateTool({ onEvent: (e) => events.push(e), run });
}

test("routes a sub-task, runs the sub-agent, returns its report", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test"; // make an in-loop provider available to the router
  const events: any[] = [];
  let ran: any = null;
  const t = makeTool(async (p: any) => { ran = p; return { text: "report: edited foo.ts", usage: { inputTokens: 100, outputTokens: 40 } }; }, events);
  const result = await (t as any).execute({ task: "refactor foo.ts to use newApi()", kind: "code" }, {});
  expect(result).toContain("report: edited foo.ts");
  expect(ran).toBeTruthy();
  expect(ran.prompt).toContain("refactor foo.ts"); // the sub-agent gets the task as its prompt
  expect(ran.model?.id).toBeTruthy(); // a model was routed
  expect(events.some((e) => e.type === "tool-start" && e.name === "delegate")).toBe(true);
  expect(events.some((e) => e.type === "tool-end")).toBe(true);
});

test("surfaces a sub-agent failure instead of throwing", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test";
  const t = makeTool(async () => ({ text: "", usage: { inputTokens: 0, outputTokens: 0 }, failure: { message: "boom" } }));
  const result = await (t as any).execute({ task: "do a thing", kind: "code" }, {});
  expect(result).toContain("failed");
  expect(result).toContain("boom");
});

test("falls back gracefully when no in-loop model is available", async () => {
  delete process.env.ANTHROPIC_API_KEY; // no provider keys → router has nothing
  // (other provider keys could exist in the env; this test only asserts no throw + a string result)
  let ran = false;
  const t = makeTool(async () => { ran = true; return { text: "x", usage: { inputTokens: 0, outputTokens: 0 } }; });
  const result = await (t as any).execute({ task: "anything", kind: "code" }, {});
  expect(typeof result).toBe("string"); // never throws — returns a message the model can act on
  if (!ran) expect(result.toLowerCase()).toContain("delegation"); // failed/skipped message when nothing routable
});
