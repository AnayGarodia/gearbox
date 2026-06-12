import { expect, test, mock } from "bun:test";
import { debounce } from "../src/debounce.ts";

test("fires after delay", async () => {
  const fn = mock(() => {});
  const d = debounce(fn, 30);
  d();
  await new Promise(r => setTimeout(r, 50));
  expect(fn).toHaveBeenCalledTimes(1);
});
test("resets timer on repeated calls", async () => {
  const fn = mock(() => {});
  const d = debounce(fn, 40);
  d(); d(); d();
  await new Promise(r => setTimeout(r, 20));
  expect(fn).toHaveBeenCalledTimes(0);
  await new Promise(r => setTimeout(r, 40));
  expect(fn).toHaveBeenCalledTimes(1);
});
test("cancel prevents firing", async () => {
  const fn = mock(() => {});
  const d = debounce(fn, 30);
  d();
  d.cancel();
  await new Promise(r => setTimeout(r, 50));
  expect(fn).toHaveBeenCalledTimes(0);
});
test("passes args", async () => {
  let captured: number[] = [];
  const d = debounce((...args: number[]) => { captured = args; }, 20);
  d(1, 2, 3);
  await new Promise(r => setTimeout(r, 40));
  expect(captured).toEqual([1, 2, 3]);
});
