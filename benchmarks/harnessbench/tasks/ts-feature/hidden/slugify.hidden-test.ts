import { expect, test } from "bun:test";
import { slugify } from "../src/slugify.ts";
test("basic", () => { expect(slugify("Hello, World!")).toBe("hello-world"); });
test("separators", () => { expect(slugify("  a_b -- c  ")).toBe("a-b-c"); });
test("empty", () => { expect(slugify("")).toBe(""); });
test("symbols", () => { expect(slugify("C++ & Rust!")).toBe("c-rust"); });
