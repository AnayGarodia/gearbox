import { expect, test } from "bun:test";
import { parseCsvLine } from "../src/csv.ts";
test("plain + empties", () => {
  expect(parseCsvLine("a,b,c")).toEqual(["a", "b", "c"]);
  expect(parseCsvLine("a,,b")).toEqual(["a", "", "b"]);
  expect(parseCsvLine("")).toEqual([""]);
});
test("quoted fields with commas and escapes", () => {
  expect(parseCsvLine('a,"b,c",d')).toEqual(["a", "b,c", "d"]);
  expect(parseCsvLine('"say ""hi""",x')).toEqual(['say "hi"', "x"]);
  expect(parseCsvLine('""')).toEqual([""]);
  expect(parseCsvLine('" a ",b')).toEqual([" a ", "b"]);
});
test("unterminated quote throws", () => {
  expect(() => parseCsvLine('"abc')).toThrow();
  expect(() => parseCsvLine('a,"b')).toThrow();
});
