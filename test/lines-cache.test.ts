import { test, expect } from "bun:test";
import { staticItemLines, itemsToLines } from "../src/ui/lines.ts";
import type { Item } from "../src/ui/types.ts";

// Streaming re-runs itemsToLines on every token. Prior assistant/user items keep
// a stable object reference across renders, so their flattened lines should be
// cached (not re-parsed each token). This caps the per-token cost to the one
// changing item instead of the whole transcript.

test("staticItemLines caches assistant lines by reference + width", () => {
  const a: Item = { kind: "assistant", id: 1, text: "# Title\n\nSome **body** text here.", done: true } as Item;
  const l1 = staticItemLines(a, 80);
  expect(staticItemLines(a, 80)).toBe(l1); // same object + width → cached
  expect(staticItemLines(a, 70)).not.toBe(l1); // width change recomputes
});

test("staticItemLines caches user lines and keys per object", () => {
  const u1: Item = { kind: "user", id: 1, text: "hello there world" } as Item;
  const u2: Item = { kind: "user", id: 2, text: "hello there world" } as Item;
  const l1 = staticItemLines(u1, 80);
  expect(staticItemLines(u1, 80)).toBe(l1);
  expect(staticItemLines(u2, 80)).not.toBe(l1); // distinct object → own cache entry
});

test("itemsToLines still emits the same content (cache is transparent)", () => {
  const items: Item[] = [
    { kind: "user", id: 1, text: "ask" } as Item,
    { kind: "assistant", id: 2, text: "# H\n\nanswer body", done: true } as Item,
  ];
  const a = itemsToLines(items, 80, false);
  const b = itemsToLines(items, 80, false);
  const flat = (ls: typeof a) => ls.map((l) => l.map((s) => s.text).join("")).join("\n");
  expect(flat(b)).toBe(flat(a));
  expect(flat(a)).toContain("answer body");
});
