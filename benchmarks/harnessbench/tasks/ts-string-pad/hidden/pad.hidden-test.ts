import { expect, test } from "bun:test";
import { padCenter } from "../src/pad.ts";
test("odd total — extra char goes on the right", () => { expect(padCenter("hi", 5)).toBe(" hi  "); });
test("odd with custom char", () => { expect(padCenter("a", 4, "*")).toBe("*a**"); });
test("even padding", () => { expect(padCenter("hi", 6)).toBe("  hi  "); });
test("already wide enough", () => { expect(padCenter("hello", 3)).toBe("hello"); });
