import { expect, test } from "bun:test";
import { highlight } from "../src/highlight.ts";
test("single value", () => { expect(highlight`Price: ${42} USD`).toBe("Price: [42] USD"); });
test("multiple values", () => { expect(highlight`${1} + ${2} = ${3}`).toBe("[1] + [2] = [3]"); });
test("no values", () => { expect(highlight`hello`).toBe("hello"); });
test("trailing text", () => { expect(highlight`val=${99}.`).toBe("val=[99]."); });
