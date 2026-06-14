import { test, expect } from "bun:test";
import { easeScrollStep, scrollSettled } from "../src/ui/scroll.ts";

test("decelerates toward the target but always moves at least one line", () => {
  // Big jump: early steps are large, late steps shrink to 1 (deceleration).
  const steps: number[] = [];
  let cur = 0;
  for (let i = 0; i < 100 && !scrollSettled(cur, 50); i++) { cur = easeScrollStep(cur, 50); steps.push(cur); }
  expect(cur).toBe(50); // reaches it
  expect(steps[0]).toBeGreaterThan(1); // first step is a big glide
  expect(steps.at(-1)! - steps.at(-2)!).toBe(1); // final approach is one line
  expect(steps.length).toBeLessThan(40); // and it converges, not crawls
});

test("a single-line nudge moves exactly one line (instant for small scrolls)", () => {
  expect(easeScrollStep(10, 11)).toBe(11);
  expect(easeScrollStep(10, 9)).toBe(9);
});

test("never overshoots in either direction", () => {
  let up = 0; for (let i = 0; i < 200 && up !== 7; i++) up = easeScrollStep(up, 7);
  expect(up).toBe(7);
  let down = 100; for (let i = 0; i < 200 && down !== 93; i++) down = easeScrollStep(down, 93);
  expect(down).toBe(93);
});

test("at the target it stays put", () => {
  expect(easeScrollStep(5, 5)).toBe(5);
  expect(scrollSettled(5, 5)).toBe(true);
});
