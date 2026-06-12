import { expect, test } from "bun:test";
import { getValue } from "../src/config";
test("0 is a valid value", () => { expect(getValue(0, 99)).toBe(0); });
test("false is a valid value", () => { expect(getValue(false, true)).toBe(false); });
test("empty string is a valid value", () => { expect(getValue("", "default")).toBe(""); });
test("null falls back to default", () => { expect(getValue(null, 42)).toBe(42); });
test("undefined falls back to default", () => { expect(getValue(undefined, "x")).toBe("x"); });
test("truthy value passes through", () => { expect(getValue(7, 99)).toBe(7); });
