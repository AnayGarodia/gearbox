import { expect, test } from "bun:test";
import { padCenter } from "../src/pad.ts";
test("even padding", () => { expect(padCenter("hi", 6)).toBe("  hi  "); });
test("odd padding — extra on right", () => { expect(padCenter("hi", 5)).toBe(" hi  "); });
test("custom char", () => { expect(padCenter("x", 5, "-")).toBe("--x--"); });
test("already wide enough", () => { expect(padCenter("hello", 3)).toBe("hello"); });
test("odd with custom char", () => { expect(padCenter("a", 4, "*")).toBe("*a**"); });
