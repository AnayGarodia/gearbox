import { expect, test } from "bun:test";
import { range } from "../src/range.ts";
test("inclusive", () => { expect(range(2, 5)).toEqual([2, 3, 4, 5]); });
test("single", () => { expect(range(3, 3)).toEqual([3]); });
test("empty when start > end", () => { expect(range(5, 2)).toEqual([]); });
