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

test("highlightLine gives editor-like colors to functions, types, operators, and brackets", () => {
  const sp = highlightLine("def add(self, title, priority=3):", "python");
  const fn = sp.find((s) => s.text === "add");
  const open = sp.find((s) => s.text === "(");
  const eq = sp.find((s) => s.text === "=");
  const arg = sp.find((s) => s.text === "priority");

  expect(fn?.color).toBeTruthy();
  expect(fn?.bold).toBe(true);
  expect(open?.color).toBeTruthy();
  expect(open?.bold).toBe(true);
  expect(eq?.color).toBeTruthy();
  expect(arg?.color).toBeTruthy();
  expect(new Set([fn?.color, open?.color, eq?.color, arg?.color]).size).toBe(4);

  const cls = highlightLine("class TaskBoard:", "python").find((s) => s.text === "TaskBoard");
  expect(cls?.color).toBeTruthy();
  expect(cls?.bold).toBe(true);

  const call = highlightLine("return sorted(open_items, key=lambda task: task.priority)[0]", "python");
  const method = call.find((s) => s.text === "priority");
  const brackets = call.filter((s) => ["(", ")", "[", "]"].includes(s.text));
  expect(method?.color).toBeTruthy();
  expect(new Set(brackets.map((s) => s.color)).size).toBeGreaterThan(1);
});
