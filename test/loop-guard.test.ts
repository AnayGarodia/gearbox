import { test, expect } from "bun:test";
import { guardToolLoops, LOOP_BLOCK_MESSAGE, LOOP_STOP_MESSAGE } from "../src/agent/run.ts";

function makeTools(log: string[]) {
  return {
    search: { description: "x", execute: async (input: any, _opts?: any) => { log.push(JSON.stringify(input)); return "result"; } },
    glob: { description: "y", execute: async (_input: any, _opts?: any) => { log.push("glob"); return "files"; } },
  };
}

test("3rd and 4th consecutive identical calls are blocked; 5th stops the turn", async () => {
  const log: string[] = [];
  let stopped = false;
  const tools = guardToolLoops(makeTools(log), () => { stopped = true; });
  const call = () => tools.search.execute({ query: "same" }, {} as any);

  expect(await call()).toBe("result");
  expect(await call()).toBe("result");
  expect(await call()).toBe(LOOP_BLOCK_MESSAGE); // 3rd: blocked, not executed
  expect(await call()).toBe(LOOP_BLOCK_MESSAGE); // 4th: still blocked
  expect(stopped).toBe(false);
  expect(await call()).toBe(LOOP_STOP_MESSAGE); // 5th: turn ends
  expect(stopped).toBe(true);
  expect(log).toHaveLength(2); // only the first two actually ran
});

test("a different call (other tool OR other input) resets the counter", async () => {
  let stopped = false;
  const tools = guardToolLoops(makeTools([]), () => { stopped = true; });

  await tools.search.execute({ query: "a" }, {} as any);
  await tools.search.execute({ query: "a" }, {} as any);
  await tools.glob.execute({ pattern: "*" }, {} as any); // breaks the run
  expect(await tools.search.execute({ query: "a" }, {} as any)).toBe("result");
  // different INPUT on the same tool also resets
  await tools.search.execute({ query: "b" }, {} as any);
  expect(await tools.search.execute({ query: "a" }, {} as any)).toBe("result");
  expect(stopped).toBe(false);
});

test("tools without an execute function pass through untouched", () => {
  const passive = { providerTool: { description: "provider-executed" } } as any;
  const tools = guardToolLoops(passive, () => {});
  expect(tools.providerTool).toBe(passive.providerTool);
});
