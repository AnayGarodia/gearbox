import { test, expect } from "bun:test";
import { navHistory } from "../src/ui/history.ts";

test("up walks back and clamps; down walks forward to the live line", () => {
  const h = ["a", "b", "c"];
  let r = navHistory(h, null, "up");
  expect(r).toEqual({ value: "c", idx: 2 });
  r = navHistory(h, r.idx, "up");
  expect(r).toEqual({ value: "b", idx: 1 });
  r = navHistory(h, r.idx, "up");
  expect(r).toEqual({ value: "a", idx: 0 });
  r = navHistory(h, r.idx, "up");
  expect(r).toEqual({ value: "a", idx: 0 }); // clamped at oldest
  r = navHistory(h, r.idx, "down");
  expect(r).toEqual({ value: "b", idx: 1 });
  r = navHistory(h, r.idx, "down");
  expect(r).toEqual({ value: "c", idx: 2 });
  r = navHistory(h, r.idx, "down");
  expect(r).toEqual({ value: "", idx: null }); // back to the live (new) line
});

test("empty history is a no-op", () => {
  expect(navHistory([], null, "up")).toEqual({ value: "", idx: null });
});
