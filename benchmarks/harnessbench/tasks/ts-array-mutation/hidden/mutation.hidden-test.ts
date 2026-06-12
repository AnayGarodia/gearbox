import { expect, test } from "bun:test";
import { topN } from "../src/ranking";

test("does not mutate the original array", () => {
  const items = [
    { name: "c", score: 3 },
    { name: "a", score: 1 },
    { name: "b", score: 2 },
  ];
  const original = [...items];
  topN(items, 2);
  expect(items).toEqual(original);
});

test("returns top N in descending order", () => {
  const items = [{ name: "c", score: 3 }, { name: "a", score: 1 }, { name: "b", score: 2 }];
  expect(topN(items, 2)).toEqual([{ name: "c", score: 3 }, { name: "b", score: 2 }]);
});

test("returns all items when n >= length", () => {
  const items = [{ name: "a", score: 5 }, { name: "b", score: 10 }];
  expect(topN(items, 10).length).toBe(2);
});
