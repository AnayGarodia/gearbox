import { expect, test } from "bun:test";
import { EventEmitter } from "../src/emitter";

type Evts = { data: string; tick: number };

test("off removes a listener", () => {
  const ee = new EventEmitter<Evts>();
  const calls: string[] = [];
  const fn = (d: string) => calls.push(d);
  ee.on("data", fn);
  ee.emit("data", "a");
  ee.off("data", fn);
  ee.emit("data", "b");
  expect(calls).toEqual(["a"]);
});

test("off with unregistered listener is a no-op", () => {
  const ee = new EventEmitter<Evts>();
  expect(() => ee.off("data", () => {})).not.toThrow();
});

test("once fires exactly once", () => {
  const ee = new EventEmitter<Evts>();
  const calls: string[] = [];
  ee.once("data", (d) => calls.push(d));
  ee.emit("data", "first");
  ee.emit("data", "second");
  ee.emit("data", "third");
  expect(calls).toEqual(["first"]);
});

test("once does not affect regular on listeners", () => {
  const ee = new EventEmitter<Evts>();
  const permanent: string[] = [];
  const one: string[] = [];
  ee.on("data", (d) => permanent.push(d));
  ee.once("data", (d) => one.push(d));
  ee.emit("data", "x");
  ee.emit("data", "y");
  expect(permanent).toEqual(["x", "y"]);
  expect(one).toEqual(["x"]);
});
