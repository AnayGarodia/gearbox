import { expect, test } from "bun:test";
import { LRUCache } from "../src/lru";

test("basic set/get", () => {
  const c = new LRUCache<string, number>(3);
  c.set("a", 1); c.set("b", 2); c.set("c", 3);
  expect(c.get("a")).toBe(1);
});

test("get promotes to MRU — accessed entry not evicted next", () => {
  const c = new LRUCache<string, number>(2);
  c.set("a", 1); c.set("b", 2);
  c.get("a"); // a is now MRU; b is LRU
  c.set("c", 3); // should evict b, not a
  expect(c.has("a")).toBe(true);
  expect(c.has("b")).toBe(false);
  expect(c.get("c")).toBe(3);
});

test("set existing key updates value and promotes to MRU", () => {
  const c = new LRUCache<string, number>(2);
  c.set("a", 1); c.set("b", 2);
  c.set("a", 10); // update a → a is now MRU; b is LRU
  c.set("c", 3); // should evict b
  expect(c.get("a")).toBe(10);
  expect(c.has("b")).toBe(false);
});

test("evicts LRU correctly over many operations", () => {
  const c = new LRUCache<number, number>(3);
  c.set(1, 1); c.set(2, 2); c.set(3, 3);
  c.get(1); // order: 2, 3, 1 (1 is MRU)
  c.set(4, 4); // evict 2
  expect(c.has(2)).toBe(false);
  expect(c.has(1)).toBe(true);
  expect(c.has(3)).toBe(true);
});

test("size never exceeds capacity", () => {
  const c = new LRUCache<number, number>(3);
  for (let i = 0; i < 10; i++) c.set(i, i);
  expect(c.size).toBe(3);
});
