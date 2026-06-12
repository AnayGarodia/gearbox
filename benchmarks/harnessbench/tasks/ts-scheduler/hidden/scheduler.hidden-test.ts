import { expect, test } from "bun:test";
import { Scheduler } from "../src/scheduler.ts";

test("runs tasks and resolves", async () => {
  const s = new Scheduler(2);
  const r = await s.run(async () => 42);
  expect(r).toBe(42);
});

test("propagates rejection", async () => {
  const s = new Scheduler(1);
  await expect(s.run(async () => { throw new Error("oops"); })).rejects.toThrow("oops");
});

test("respects concurrency limit", async () => {
  const s = new Scheduler(2);
  let running = 0;
  let maxSeen = 0;
  const task = () => new Promise<void>(res => {
    running++;
    maxSeen = Math.max(maxSeen, running);
    setTimeout(() => { running--; res(); }, 20);
  });
  await Promise.all([s.run(task), s.run(task), s.run(task), s.run(task)]);
  expect(maxSeen).toBeLessThanOrEqual(2);
});

test("all tasks eventually complete", async () => {
  const s = new Scheduler(2);
  const results: number[] = [];
  await Promise.all([1, 2, 3, 4, 5].map(n => s.run(async () => { results.push(n); })));
  expect(results.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
});
