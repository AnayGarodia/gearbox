import { test, expect } from "bun:test";
import { highlightLine } from "../src/ui/highlight.ts";

const txt = (sp: { text: string }[]) => sp.map((s) => s.text).join("");

test("highlightLine preserves the exact line text", () => {
  const line = 'const x = "hi"; // note';
  expect(txt(highlightLine(line, "ts"))).toBe(line);
});

test("highlightLine colors keywords, strings, numbers, comments distinctly", () => {
  const sp = highlightLine('const n = 42; // c', "ts");
  const kw = sp.find((s) => s.text === "const");
  const num = sp.find((s) => s.text === "42");
  const comment = sp.find((s) => s.text.includes("// c"));
  expect(kw?.bold).toBe(true);
  expect(kw?.color).toBeTruthy();
  expect(num?.color).toBeTruthy();
  expect(comment?.color).toBeTruthy();
  // keyword, number, and comment use different colors
  expect(new Set([kw?.color, num?.color, comment?.color]).size).toBe(3);
});

test("highlightLine treats # as a comment only in hash-comment languages", () => {
  expect(highlightLine("x = 1 # py comment", "py").some((s) => s.text.includes("# py"))).toBe(true);
  // in JS, # is not a line comment — the text after it is not one faint span
  const js = highlightLine("a # b", "js");
  expect(js.some((s) => s.text === "# b")).toBe(false);
});
