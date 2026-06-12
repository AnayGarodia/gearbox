import { expect, test } from "bun:test";
import { deepClone } from "../src/clone";

test("handles null", () => {
  expect(deepClone(null)).toBeNull();
});

test("primitives pass through", () => {
  expect(deepClone(42)).toBe(42);
  expect(deepClone("hello")).toBe("hello");
  expect(deepClone(true)).toBe(true);
});

test("clones Date (not shared reference)", () => {
  const original = new Date("2024-01-01");
  const clone = deepClone(original);
  expect(clone.getTime()).toBe(original.getTime());
  clone.setFullYear(2000);
  expect(original.getFullYear()).toBe(2024);
});

test("clones nested arrays (not shared reference)", () => {
  const original = { tags: ["a", "b"] };
  const clone = deepClone(original);
  clone.tags.push("c");
  expect(original.tags).toEqual(["a", "b"]);
});

test("clones nested objects deeply", () => {
  const original = { a: { b: { c: 1 } } };
  const clone = deepClone(original);
  clone.a.b.c = 99;
  expect(original.a.b.c).toBe(1);
});

test("handles circular references without infinite loop", () => {
  const obj: Record<string, unknown> = { x: 1 };
  obj.self = obj;
  expect(() => deepClone(obj)).not.toThrow();
});
