import { expect, test } from "bun:test";
import { makeCounter } from "../src/counter.ts";
test("new counter starts at zero", () => {
  expect(makeCounter().value()).toBe(0);
});
test("independent counters", () => {
  const a = makeCounter();
  const b = makeCounter();
  a.increment(); a.increment();
  b.increment();
  expect(a.value()).toBe(2);
  expect(b.value()).toBe(1);
});
test("decrement", () => {
  const c = makeCounter();
  c.increment(); c.increment(); c.decrement();
  expect(c.value()).toBe(1);
});
