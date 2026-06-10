import { test, expect } from "bun:test";
import { collapseTurn, retryPhrase } from "../src/ui/collapse.ts";
import type { Item } from "../src/ui/types.ts";

let seq = 1000;
const nextId = () => seq++;

function kinds(items: Item[]): string[] {
  return items.map((i) => i.kind);
}

test("drops phases and context-gathering reads, keeps read/edit", () => {
  const items: Item[] = [
    { kind: "user", id: 1, text: "do it" },
    { kind: "phase", id: 2, label: "building context", state: "running" },
    { kind: "tool", id: 3, callId: "a", name: "list_dir", arg: ".", status: "ok", summary: "12 entries" },
    { kind: "tool", id: 4, callId: "b", name: "read_file", arg: "src/config.ts", status: "ok", summary: "34 lines" },
    { kind: "phase", id: 5, label: "tool finished", state: "ok" },
    { kind: "tool", id: 6, callId: "c", name: "edit_file", arg: "src/config.ts", status: "ok", summary: "edited", diff: [{ sign: "+", text: "x" }] },
    { kind: "phase", id: 7, label: "finished", state: "ok" },
    { kind: "assistant", id: 8, text: "done", done: true },
  ];
  const out = collapseTurn(items, nextId);
  expect(kinds(out)).toEqual(["user", "tool", "tool", "assistant"]);
  expect(out.filter((i) => i.kind === "phase")).toHaveLength(0);
  // list_dir gone, read + edit stay
  const tools = out.filter((i): i is Extract<Item, { kind: "tool" }> => i.kind === "tool");
  expect(tools.map((t) => t.name)).toEqual(["read_file", "edit_file"]);
});

test("folds a failed-then-passed typecheck into one final-state verification", () => {
  const items: Item[] = [
    { kind: "user", id: 1, text: "fix types" },
    { kind: "tool", id: 2, callId: "a", name: "run_shell", arg: "cd /x && bun run typecheck 2>&1 | tail -20", status: "err", summary: "1 error", outputTail: "$ tsc --noEmit\nerror TS2322", durationMs: 1400 },
    { kind: "tool", id: 3, callId: "b", name: "edit_file", arg: "src/config.ts", status: "ok", summary: "edited" },
    { kind: "verification", id: 4, command: "bun run typecheck", ok: true, summary: "passed", intent: "typecheck", durationMs: 1200, output: "$ tsc --noEmit" },
    { kind: "assistant", id: 5, text: "done", done: true },
  ];
  const out = collapseTurn(items, nextId);
  const checks = out.filter((i): i is Extract<Item, { kind: "verification" }> => i.kind === "verification");
  expect(checks).toHaveLength(1);
  const c = checks[0]!;
  expect(c.intent).toBe("typecheck");
  expect(c.ok).toBe(true); // final state, despite first attempt failing
  expect(c.attempts).toBe(2);
  expect(c.durationMs).toBe(2600); // summed
  // the edit between attempts is preserved
  expect(out.some((i) => i.kind === "tool" && (i as any).name === "edit_file")).toBe(true);
  // no raw run_shell typecheck left behind
  expect(out.some((i) => i.kind === "tool" && (i as any).name === "run_shell")).toBe(false);
});

test("a non-check shell command is kept verbatim", () => {
  const items: Item[] = [
    { kind: "tool", id: 1, callId: "a", name: "run_shell", arg: "git status", status: "ok", summary: "clean" },
  ];
  const out = collapseTurn(items, nextId);
  expect(out).toHaveLength(1);
  expect(out[0]!.kind).toBe("tool");
});

test("retryPhrase reads naturally", () => {
  expect(retryPhrase(true, 1)).toBe("");
  expect(retryPhrase(true, 2)).toBe("retried once");
  expect(retryPhrase(true, 3)).toBe("retried 2 times");
  expect(retryPhrase(false, 2)).toBe("failed after 2 attempts");
});

import { collapseToolRuns } from "../src/ui/collapse.ts";

const mkTool = (id: number, name: string, over: any = {}) =>
  ({ kind: "tool", id, callId: `c${id}`, name, status: "ok", summary: "", ...over }) as any;

test("collapseToolRuns: ≥3 consecutive quick steps fold into one expandable row", () => {
  let nid = 100;
  const items = [
    mkTool(1, "read_file"), mkTool(2, "read_file"), mkTool(3, "run_shell"), mkTool(4, "read_file"),
    mkTool(5, "edit_file", { diff: [{ sign: "+", text: "x" }] }),
  ];
  const out = collapseToolRuns(items as any, () => nid++);
  expect(out).toHaveLength(2);
  const group: any = out[0];
  expect(group.collapsed).toBe(true);
  expect(group.children).toHaveLength(4);
  expect(group.summary).toContain("4 quick steps");
  expect(group.summary).toContain("read ×3");
  expect(group.summary).toContain("shell");
  expect((out[1] as any).name).toBe("edit_file"); // the work record stays verbatim
});

test("collapseToolRuns: short runs and edits stay untouched; an error taints the group red", () => {
  let nid = 100;
  const short = collapseToolRuns([mkTool(1, "read_file"), mkTool(2, "read_file")] as any, () => nid++);
  expect(short).toHaveLength(2); // <3 → verbatim
  const withErr = collapseToolRuns(
    [mkTool(1, "read_file"), mkTool(2, "run_shell", { status: "err" }), mkTool(3, "read_file")] as any,
    () => nid++,
  );
  expect((withErr[0] as any).status).toBe("err"); // a red step can't hide inside a green group
});
