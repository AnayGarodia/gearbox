import { test, expect } from "bun:test";
import { markdownToLines } from "../src/ui/lines.ts";
import { PROSE_RE, proseTokenStyle } from "../src/ui/prose.ts";
import { color } from "../src/ui/theme.ts";

// ── the shared tokenizer, unit-tested directly ───────────────────────────────
const tokens = (s: string) => Array.from(s.matchAll(PROSE_RE), (m) => m[0]!.trim());
const styleOf = (s: string) => proseTokenStyle(tokens(s)[0]!);

test("highlights file paths and filenames", () => {
  expect(tokens("open src/ui/theme.ts now")).toContain("src/ui/theme.ts");
  expect(tokens("see package.json")).toContain("package.json");
  expect(styleOf("src/ui/theme.ts x").color).toBe(color.path);
});

test("highlights code identifiers (camelCase, snake_case, calls) but not plain words", () => {
  expect(tokens("the markdownToLines helper")).toContain("markdownToLines");
  expect(tokens("uses user_name here")).toContain("user_name");
  expect(tokens("call proseSpans() please")).toContain("proseSpans");
  expect(styleOf("markdownToLines x").color).toBe(color.accent);
  // plain English words are not identifiers
  expect(tokens("the thing to remember here")).toEqual([]);
});

test("highlights PascalCase type names, not sentence-initial words", () => {
  expect(tokens("the RoutingSelector picks one")).toContain("RoutingSelector");
  expect(tokens("However it works fine")).toEqual([]);
});

test("highlights product names as emphasis", () => {
  expect(tokens("Claude is fast")).toContain("Claude");
  expect(styleOf("Claude is fast").color).toBe(color.user);
});

test("highlights slash-commands, numbers, and short quotes", () => {
  expect(tokens("type /usage to check")).toContain("/usage");
  expect(tokens("there are 3 files")).toContain("3");
  expect(tokens('he said "hello there" today')).toContain('"hello there"');
  expect(styleOf("/usage x").color).toBe(color.path);
  expect(styleOf("3 files").color).toBe(color.codeNumber);
  expect(styleOf('"hi" x').color).toBe(color.codeString);
});

// ── regressions: ordinary English must stay plain (the reported bugs) ─────────
test("does NOT color apostrophes as strings", () => {
  expect(tokens("Tell me what you're working on. What's up?")).toEqual([]);
});

test("a command-ish word does not swallow the rest of the sentence", () => {
  expect(tokens("You can go to usage to see your spend.")).toEqual([]);
});

test("a multi-word phrase ending in a colon is not a label", () => {
  expect(tokens("Here is the thing to remember: it works.")).toEqual([]);
});

test('"and/or" is not treated as a path', () => {
  expect(tokens("It is good and/or bad.")).toEqual([]);
});

// ── end-to-end through markdownToLines (the real render path) ─────────────────
const spans = (md: string) => markdownToLines(md, 80).flat();
const has = (md: string, c: string) => spans(md).some((s) => s.color === c);

test("end-to-end: plain prose has no string/accent false positives", () => {
  const md = "Tell me what you're working on. What's up?";
  expect(has(md, color.codeString)).toBe(false);
  expect(has(md, color.accent)).toBe(false);
});

test("end-to-end: technical prose lights up the right tokens", () => {
  const md = "The markdownToLines helper in src/ui/lines.ts returns 2 spans.";
  expect(has(md, color.accent)).toBe(true); // markdownToLines
  expect(has(md, color.path)).toBe(true); // src/ui/lines.ts
  expect(has(md, color.codeNumber)).toBe(true); // 2
});
