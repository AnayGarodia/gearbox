import { expect, test } from "bun:test";
import { parseKV } from "../src/parse.ts";
test("value containing =", () => { expect(parseKV("k=a=b")).toEqual({ k: "a=b" }); });
test("plain", () => { expect(parseKV("a=1\nb=2")).toEqual({ a: "1", b: "2" }); });
test("blank lines", () => { expect(parseKV("a=1\n\n")).toEqual({ a: "1" }); });
