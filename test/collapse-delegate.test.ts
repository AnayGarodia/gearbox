import { test, expect } from "bun:test";
import { collapseDelegateGroups } from "../src/ui/collapse.ts";
import type { Item } from "../src/ui/types.ts";

const tool = (p: Partial<Extract<Item, { kind: "tool" }>> & { callId: string; name: string }): Item =>
  ({ kind: "tool", id: 1, status: "ok", summary: "", arg: "", ...p } as Item);

test("a finished delegate_parallel group folds its children into one collapsed item", () => {
  const items: Item[] = [
    tool({ id: 1, callId: "delegate_parallel-1", name: "delegate_parallel", summary: "5 done · 31 merged", durationMs: 90_000 }),
    tool({ id: 2, callId: "delegate_parallel-1:0", name: "delegate" }),
    tool({ id: 3, callId: "delegate_parallel-1:1", name: "delegate" }),
    { kind: "assistant", id: 4, text: "ok" } as Item,
  ];
  const out = collapseDelegateGroups(items);
  // the two children are gone from the flat list:
  expect(out.filter((i) => i.kind === "tool" && i.callId.includes(":")).length).toBe(0);
  const group = out.find((i) => i.kind === "tool" && i.name === "delegate_parallel") as Extract<Item, { kind: "tool" }>;
  expect(group.collapsed).toBe(true);
  expect(group.children?.length).toBe(2); // folded in for ⌃O expand
  expect(group.summary).toBe("5 done · 31 merged"); // preserved
  expect(out.some((i) => i.kind === "assistant")).toBe(true); // unrelated items untouched
});

test("a still-running group is left alone (collapses only once settled)", () => {
  const items: Item[] = [
    tool({ id: 1, callId: "delegate_parallel-2", name: "delegate_parallel", status: "running" }),
    tool({ id: 2, callId: "delegate_parallel-2:0", name: "delegate", status: "running" }),
  ];
  const out = collapseDelegateGroups(items);
  expect(out.length).toBe(2); // nothing folded
  expect(out.every((i) => !(i.kind === "tool" && i.collapsed))).toBe(true);
});

test("a lone sequential delegate is not collapsed (already compact)", () => {
  const items: Item[] = [tool({ id: 1, callId: "delegate-9", name: "delegate", summary: "edited foo.ts" })];
  const out = collapseDelegateGroups(items);
  expect(out[0]).toEqual(items[0]); // unchanged
});

test("folding is idempotent — runs live on every render AND again at end-of-turn", () => {
  const items: Item[] = [
    tool({ id: 1, callId: "delegate_parallel-3", name: "delegate_parallel", summary: "5 done", durationMs: 90_000 }),
    tool({ id: 2, callId: "delegate_parallel-3:0", name: "delegate" }),
    tool({ id: 3, callId: "delegate_parallel-3:1", name: "delegate" }),
  ];
  const once = collapseDelegateGroups(items);
  const twice = collapseDelegateGroups(once);
  // Re-folding an already-collapsed group must NOT wipe its children.
  const g1 = once.find((i) => i.kind === "tool" && i.name === "delegate_parallel") as Extract<Item, { kind: "tool" }>;
  const g2 = twice.find((i) => i.kind === "tool" && i.name === "delegate_parallel") as Extract<Item, { kind: "tool" }>;
  expect(g2.collapsed).toBe(true);
  expect(g2.children?.length).toBe(2); // preserved, not zeroed
  expect(twice).toEqual(once); // a true no-op the second time
});
