import { expect, test } from "bun:test";
import * as m from "../src/stats.ts";
test("summary behavior pinned", () => {
  expect(m.summary([])).toEqual({ mean: 0, median: 0 });
  expect(m.summary([1, 2, 3, 4])).toEqual({ mean: 2.5, median: 2.5 });
  expect(m.summary([5, 1, 3])).toEqual({ mean: 3, median: 3 });
});
test("refactor shipped the named exports", () => {
  expect(typeof (m as any).mean).toBe("function");
  expect(typeof (m as any).median).toBe("function");
  expect((m as any).mean([2, 4])).toBe(3);
  expect((m as any).median([2, 4])).toBe(3);
});
