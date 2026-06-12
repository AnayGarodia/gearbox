import { expect, test } from "bun:test";
import { highlight } from "../src/highlight.ts";
test("trailing text preserved", () => { expect(highlight`Price: ${42} USD`).toBe("Price: [42] USD"); });
test("trailing text with two values", () => { expect(highlight`${1} and ${2} done`).toBe("[1] and [2] done"); });
test("no values", () => { expect(highlight`hello`).toBe("hello"); });
test("trailing punctuation", () => { expect(highlight`val=${99}.`).toBe("val=[99]."); });
