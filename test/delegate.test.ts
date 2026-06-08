import { test, expect, afterEach } from "bun:test";
import { makeDelegateTools } from "../src/agent/delegate.ts";

const origKey = process.env.ANTHROPIC_API_KEY;
afterEach(() => {
  if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = origKey;
});

function makeTool(run: any, events: any[] = []) {
  return makeDelegateTools({ onEvent: (e) => events.push(e), run }).delegate;
}

test("exposes both delegate and delegate_parallel", () => {
  const set = makeDelegateTools({ onEvent: () => {}, run: async () => ({ text: "", usage: { inputTokens: 0, outputTokens: 0 } }) });
  expect(Object.keys(set).sort()).toEqual(["delegate", "delegate_parallel"]);
});

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

test("streams the sub-agent's actions onto the delegate line (not a silent black box)", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test";
  const events: any[] = [];
  const t = makeTool(async (p: any) => {
    // the sub-agent does some work, emitting its own tool-starts
    p.onEvent({ type: "tool-start", id: "s1", name: "read_file", arg: `${process.cwd()}/src/foo.ts` });
    p.onEvent({ type: "tool-start", id: "s2", name: "edit_file", arg: `${process.cwd()}/src/foo.ts` });
    return { text: "done", usage: { inputTokens: 10, outputTokens: 5 } };
  }, events);
  await (t as any).execute({ task: "edit foo", kind: "code" }, {});
  const streams = events.filter((e) => e.type === "tool-stream");
  expect(streams.length).toBe(2);
  expect(streams[0].delta).toContain("reading src/foo.ts"); // verb-mapped + path relativized
  expect(streams[1].delta).toContain("editing src/foo.ts");
  const start = events.find((e) => e.type === "tool-start" && e.name === "delegate");
  expect(streams.every((s) => s.id === start.id)).toBe(true); // onto the SAME delegate line
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
