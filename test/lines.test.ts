import { test, expect } from "bun:test";
import { wrapSpans, itemsToLines, clipSpans } from "../src/ui/lines.ts";
import { displayWidth } from "../src/ui/width.ts";
import type { Item } from "../src/ui/types.ts";

// Width = display COLUMNS (emoji/CJK count 2), the unit the terminal cares about.
const lineLen = (line: { text: string }[]) => line.reduce((n, s) => n + displayWidth(s.text), 0);

test("wrapSpans never exceeds the width and keeps all words", () => {
  const text = "the quick brown fox jumps over the lazy dog again and again";
  const lines = wrapSpans([{ text }], 20);
  for (const l of lines) expect(lineLen(l)).toBeLessThanOrEqual(20);
  expect(lines.map((l) => l.map((s) => s.text).join("")).join(" ")).toContain("quick brown fox");
});

test("wrapSpans hard-breaks a word longer than the width", () => {
  const lines = wrapSpans([{ text: "x".repeat(50) }], 10);
  expect(lines.length).toBeGreaterThanOrEqual(5);
  for (const l of lines) expect(lineLen(l)).toBeLessThanOrEqual(10);
});

test("itemsToLines keeps every line within the width (no overflow → no corruption)", () => {
  const W = 40;
  const items: Item[] = [
    { kind: "user", id: 1, text: "please refactor the entire authentication subsystem and explain each step thoroughly" },
    { kind: "assistant", id: 2, text: "Sure. Here is **a long** explanation with a `codeSpan` and a fenced block:\n\n```\nconst reallyLongIdentifierThatExceedsTheLineWidthForSure = 1\n```\n\nDone.", done: true },
    { kind: "tool", id: 3, callId: "a", name: "run", arg: "bun test --coverage --reporter=verbose", status: "ok", summary: "26 passed" },
    { kind: "notice", id: 4, text: "a multi\nline\nnotice output that simulates cat of a file with several lines" },
  ];
  const lines = itemsToLines(items, W);
  expect(lines.length).toBeGreaterThan(0);
  for (const l of lines) expect(lineLen(l)).toBeLessThanOrEqual(W);
});

test("a multi-line notice becomes multiple lines", () => {
  const lines = itemsToLines([{ kind: "notice", id: 1, text: "one\ntwo\nthree" }], 60);
  // 1 leading blank + 3 content lines
  expect(lines.length).toBeGreaterThanOrEqual(4);
});

test("fullscreen line buffer formats unfenced source as code", () => {
  const source = [
    "from dataclasses import dataclass",
    "from random import Random",
    "",
    "@dataclass(frozen=True)",
    "class Task:",
    "    name: str",
    "    effort: int",
  ].join("\n");
  const lines = itemsToLines([{ kind: "assistant", id: 1, text: source, done: true }], 80);
  const text = lines.map((l) => l.map((s) => s.text).join("")).join("\n");

  expect(text).toContain("python"); // lang label kept
  expect(text).toContain("from dataclasses import dataclass"); // code rendered (no "N │" gutter now)
  expect(text).not.toContain("1 │ from dataclasses"); // the line-number gutter was removed (cleaner snippets)
  expect(text).toContain("class Task:");
  for (const l of lines) expect(lineLen(l)).toBeLessThanOrEqual(80);
});

test("diff output paints added and removed rows with full-line backgrounds", () => {
  const lines = itemsToLines([
    {
      kind: "tool",
      id: 1,
      callId: "a",
      name: "edit_file",
      arg: "src/example.ts",
      status: "ok",
      summary: "updated src/example.ts",
      diff: [
        { sign: "-", text: "const oldValue = 1;" },
        { sign: "+", text: "const newValue = compute(2);" },
      ],
    },
  ], 72, true);
  const diffRows = lines.filter((l) => l.some((s) => s.text.includes("oldValue") || s.text.includes("newValue")));

  expect(diffRows.length).toBe(2);
  for (const row of diffRows) {
    expect(row.every((s) => s.bg)).toBe(true);
    expect(lineLen(row)).toBe(72);
  }
});

test("markdown tables render as aligned columns, not a '·'-joined blob", () => {
  const md = "| File | Tests |\n| --- | --- |\n| `a.ts` | 103 |\n| `b.ts` | 14 |";
  const lines = itemsToLines([{ kind: "assistant", id: 1, text: md, done: true }], 80);
  const text = lines.map((l) => l.map((s) => s.text).join("")).join("\n");
  expect(text).toContain("File");
  expect(text).toContain("Tests");
  expect(text).toContain("103");
  expect(text).toMatch(/─{3,}/); // a header underline rule
  expect(text).not.toContain("·  "); // the old flattened cell separator is gone
  // header label and its column value line up (same start column)
  const fileCol = lines.find((l) => l.map((s) => s.text).join("").includes("File"))!;
  const aCol = lines.find((l) => l.map((s) => s.text).join("").includes("a.ts"))!;
  const startOf = (l: typeof fileCol, needle: string) => l.map((s) => s.text).join("").indexOf(needle);
  expect(startOf(aCol, "a.ts")).toBe(startOf(fileCol, "File"));
});

test("consecutive tool calls render tight (no blank line between them)", () => {
  const tools: Item[] = [
    { kind: "tool", id: 1, callId: "a", name: "read_file", arg: "x.ts", status: "ok", summary: "10 lines" },
    { kind: "tool", id: 2, callId: "b", name: "read_file", arg: "y.ts", status: "ok", summary: "20 lines" },
  ];
  const lines = itemsToLines(tools, 80);
  const blanks = lines.filter((l) => l.length === 0).length;
  // exactly ONE leading blank for the whole block — not one per tool.
  expect(blanks).toBe(1);
});

test("an error item renders one red left-bar lane (▎), not the old ▲ marker", () => {
  const items: Item[] = [{ kind: "error", id: 1, text: "rate limited · try /account" }];
  const lines = itemsToLines(items, 60);
  const text = lines.map((l) => l.map((s) => s.text).join("")).join("\n");
  expect(text).toContain("▎"); // the red left bar spine
  expect(text).not.toContain("▲"); // the triangle marker is gone from errors
  expect(text).toContain("rate limited");
});

test("a multi-line error keeps the left bar on every line and stays within width", () => {
  const items: Item[] = [{ kind: "error", id: 1, text: "line one is here\nline two is also here" }];
  const lines = itemsToLines(items, 40).filter((l) => l.some((s) => s.text.includes("▎")));
  expect(lines.length).toBeGreaterThanOrEqual(2); // a bar on each paragraph line
  for (const l of itemsToLines(items, 40)) {
    expect(l.reduce((n, s) => n + s.text.length, 0)).toBeLessThanOrEqual(40);
  }
});

test("a read tool shows a path relative to the cwd, not the noisy absolute path", () => {
  const cwd = process.cwd();
  const items: Item[] = [{ kind: "tool", id: 1, callId: "a", name: "read", arg: `${cwd}/src/ui/App.tsx`, status: "ok", summary: "" }];
  const text = itemsToLines(items, 110).map((l) => l.map((s) => s.text).join("")).join("\n");
  expect(text).toContain("src/ui/App.tsx");
  expect(text).not.toContain(cwd); // the absolute prefix is gone
});

test("a long-running tool shows a live ticking elapsed (the 'it's alive' signal)", () => {
  const items: Item[] = [{ kind: "tool", id: 1, callId: "a", name: "Agent", arg: "analyze the codebase", status: "running", summary: "", startedAt: Date.now() - 84_000 }];
  const text = itemsToLines(items, 110).map((l) => l.map((s) => s.text).join("")).join("\n");
  expect(text).toContain("agent"); // friendlyTool(Agent)
  expect(text).toMatch(/1m \d+s/); // ~84s shown as 1m 2Ns
});

test("clipSpans clips by display columns and never splits a surrogate pair", () => {
  const clipped = clipSpans([{ text: "🎉🎉🎉" }], 5); // 6 columns of emoji, 5 allowed
  const text = clipped.map((s) => s.text).join("");
  expect(text).toBe("🎉🎉"); // the half-fitting third emoji is dropped whole
  expect(lineLen(clipped)).toBeLessThanOrEqual(5);
  // no lone surrogate produced by the cut
  expect(/[\uD800-\uDFFF]/.test(text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""))).toBe(false);
});

test("wrapSpans measures wide chars as 2 columns (the ≤width invariant in display columns)", () => {
  const lines = wrapSpans([{ text: "漢字テストの長い行がここで折り返されるはず" }], 10);
  expect(lines.length).toBeGreaterThanOrEqual(4); // ~42 columns over 10-col lines
  for (const l of lines) expect(lineLen(l)).toBeLessThanOrEqual(10);
});

test("itemsToLines keeps the width invariant in display columns for emoji/CJK content", () => {
  const W = 40;
  const items: Item[] = [
    { kind: "user", id: 1, text: "请把整个鉴权子系统重构一下，并且详细解释每一步 🚀🚀🚀" },
    { kind: "assistant", id: 2, text: "好的 🎉 这是**很长的**解释，带一个代码块：\n\n```\nconst 名前がとても長い識別子テスト変数 = \"🎉🎉🎉🎉🎉🎉🎉🎉\"\n```\n\n完了。", done: true },
    { kind: "tool", id: 3, callId: "a", name: "run_shell", arg: "echo 漢字テスト🎉漢字テスト🎉漢字テスト🎉漢字テスト🎉", status: "ok", summary: "出力 🎉 漢字テスト漢字テスト漢字テスト漢字テスト漢字" },
    { kind: "notice", id: 4, text: "複数行の\n通知テキスト 🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉" },
    { kind: "error", id: 5, text: "限流了 🛑 请稍后再试 限流了请稍后再试限流了请稍后再试限流了请稍后再试" },
  ];
  const lines = itemsToLines(items, W);
  expect(lines.length).toBeGreaterThan(0);
  for (const l of lines) expect(lineLen(l)).toBeLessThanOrEqual(W);
  // and no line ever ends up with a lone surrogate (a half emoji)
  for (const l of lines) {
    const text = l.map((s) => s.text).join("");
    expect(/[\uD800-\uDFFF]/.test(text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""))).toBe(false);
  }
});

test("a diff with emoji content still paints full-width rows within the width", () => {
  const W = 60;
  const lines = itemsToLines([
    {
      kind: "tool", id: 1, callId: "a", name: "edit_file", arg: "src/emoji.ts", status: "ok", summary: "updated",
      diff: [
        { sign: "-", text: "const msg = \"plain\";" },
        { sign: "+", text: "const msg = \"🎉 done 漢字テスト 🎉 celebration time 🎉\";" },
      ],
    },
  ], W, true);
  for (const l of lines) expect(lineLen(l)).toBeLessThanOrEqual(W);
});

test("a tool whose summary just repeats its name omits the redundant result line", () => {
  const redundant: Item[] = [{ kind: "tool", id: 1, callId: "a", name: "Read", arg: "src/x.ts", status: "ok", summary: "Read" }];
  const t1 = itemsToLines(redundant, 110).map((l) => l.map((s) => s.text).join("")).join("\n");
  expect(t1).not.toContain("⎿ Read");
  const useful: Item[] = [{ kind: "tool", id: 2, callId: "b", name: "Read", arg: "src/x.ts", status: "ok", summary: "42 lines" }];
  const t2 = itemsToLines(useful, 110).map((l) => l.map((s) => s.text).join("")).join("\n");
  expect(t2).toContain("42 lines"); // a real summary IS kept
});

// ── the in-stream fork affordance ─────────────────────────────────────────────
import { linkAt } from "../src/ui/lines.ts";

test("the routed-model line carries a clickable ⑂ fork (gearbox:fork link)", () => {
  const items: Item[] = [{ kind: "model", id: 9, model: "deepseek-v4", provider: "deepseek", costText: "seat ~$0" }];
  const lines = itemsToLines(items, 110);
  const modelLine = lines.find((l) => l.some((s) => s.text.includes("fork")))!;
  expect(modelLine).toBeDefined();
  const forkSpan = modelLine.find((s) => s.link === "gearbox:fork")!;
  expect(forkSpan.text).toContain("⑂ fork");
  // linkAt resolves the char column under the fork text to the link
  let pos = 0;
  for (const s of modelLine) { if (s.link === "gearbox:fork") break; pos += s.text.length; }
  expect(linkAt(modelLine, pos + 2)).toBe("gearbox:fork");
  expect(linkAt(modelLine, 0)).toBeUndefined();
});
