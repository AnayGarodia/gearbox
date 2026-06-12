import { expect, test } from "bun:test";
import { truncate } from "../src/truncate.ts";
test("emoji not split", () => { expect(truncate("👍👍👍", 2)).toBe("👍👍…"); });
test("no cut, no ellipsis", () => { expect(truncate("abc", 3)).toBe("abc"); });
test("empty", () => { expect(truncate("", 5)).toBe(""); });
test("cut ascii", () => { expect(truncate("abcdef", 4)).toBe("abcd…"); });
