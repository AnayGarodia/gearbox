import { expect, test } from "bun:test";
import { normalize } from "../src/transform";
import { runPipeline } from "../src/pipeline";

test("normalize divides by max", () => {
  expect(normalize([2, 4, 8])).toEqual([0.25, 0.5, 1]);
});

test("normalize handles single element", () => {
  expect(normalize([5])).toEqual([1]);
});

test("pipeline filters first then normalizes", () => {
  // raw: [1, 3, 5, 10]; threshold 4 → keep [5, 10] → normalize by 10 → [0.5, 1]
  const result = runPipeline([1, 3, 5, 10], 4);
  expect(result).toEqual([0.5, 1]);
});

test("pipeline empty after filter", () => {
  expect(runPipeline([1, 2, 3], 10)).toEqual([]);
});
