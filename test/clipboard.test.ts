import { test, expect } from "bun:test";
import { osc52 } from "../src/ui/clipboard.ts";

test("osc52 wraps base64 content in the OSC 52 sequence", () => {
  const seq = osc52("hello");
  expect(seq).toBe(`\x1b]52;c;${Buffer.from("hello").toString("base64")}\x07`);
  expect(seq.startsWith("\x1b]52;c;")).toBe(true);
  expect(seq.endsWith("\x07")).toBe(true);
});

test("osc52 round-trips utf-8", () => {
  const text = "snowman ☃ and \"quotes\"\nnewline";
  const b64 = osc52(text).slice("\x1b]52;c;".length, -1);
  expect(Buffer.from(b64, "base64").toString("utf8")).toBe(text);
});
