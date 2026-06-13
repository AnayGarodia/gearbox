import { test, expect } from "bun:test";
import {
  clampIndex, clampScroll, panelBodyHeight, windowStart,
  filterModelRows, appendFilter, backspaceFilter, mergeConfirmOpen, mergeConfirmScroll, type PanelModelRow, type PanelState,
} from "../src/ui/panel.ts";

test("mergeConfirmOpen splits the diff into lines and titles the branch", () => {
  const p = mergeConfirmOpen("@@ -1 +1 @@\n-old\n+new\n", "tab/fix");
  expect(p.kind).toBe("merge-confirm");
  expect(p.title).toContain("tab/fix");
  expect(p.lines).toEqual(["@@ -1 +1 @@", "-old", "+new"]);
  expect(p.scroll).toBe(0);
});

test("mergeConfirmOpen shows a placeholder when there is no diff", () => {
  expect(mergeConfirmOpen("", "tab/x").lines).toEqual(["(no changes to merge)"]);
});

test("mergeConfirmScroll clamps to [0, lines - view]", () => {
  const p = mergeConfirmOpen(Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n"), "b");
  expect(mergeConfirmScroll(p, -5, 4).scroll).toBe(0); // can't go negative
  expect(mergeConfirmScroll(p, 100, 4).scroll).toBe(6); // 10 lines - 4 view
});

test("clampIndex keeps selection in range (and 0 when empty)", () => {
  expect(clampIndex(5, 3)).toBe(2);
  expect(clampIndex(-1, 3)).toBe(0);
  expect(clampIndex(0, 0)).toBe(0);
  expect(clampIndex(2, 0)).toBe(0);
});

test("clampScroll stays within [0, max]", () => {
  expect(clampScroll(-3, 10)).toBe(0);
  expect(clampScroll(99, 10)).toBe(10);
  expect(clampScroll(4, 10)).toBe(4);
  expect(clampScroll(4, -1)).toBe(0); // negative max floored to 0
});

test("panelBodyHeight reserves the header + footer rows", () => {
  expect(panelBodyHeight(10)).toBe(8);
  expect(panelBodyHeight(2)).toBe(1); // never below 1
});

test("windowStart keeps the selection visible in a scrolling list", () => {
  expect(windowStart(0, 100, 10)).toBe(0); // top
  expect(windowStart(99, 100, 10)).toBe(90); // bottom clamps
  expect(windowStart(50, 100, 10)).toBe(45); // centered-ish
  expect(windowStart(3, 5, 10)).toBe(0); // fits → no scroll
});

const ROWS: PanelModelRow[] = [
  { id: "claude-haiku-4-5", label: "haiku-4.5", provider: "anthropic", current: false },
  { id: "azure-foundry/gpt-5-2025-08-07", label: "gpt-5-2025-08-07", provider: "azure-foundry", current: true },
  { id: "groq/llama-3.3-70b", label: "llama-3.3-70b", provider: "groq", current: false },
];

test("filterModelRows matches label, id, or provider (case-insensitive)", () => {
  expect(filterModelRows(ROWS, "").length).toBe(3); // empty → all
  expect(filterModelRows(ROWS, "haiku").map((r) => r.id)).toEqual(["claude-haiku-4-5"]);
  expect(filterModelRows(ROWS, "AZURE").map((r) => r.provider)).toEqual(["azure-foundry"]);
  expect(filterModelRows(ROWS, "gpt-5").length).toBe(1);
  expect(filterModelRows(ROWS, "zzz").length).toBe(0);
});

test("append/backspace edit the model filter and reset the selection", () => {
  const p: Extract<PanelState, { kind: "models" }> = { kind: "models", title: "models", index: 4, filter: "ha" };
  const a = appendFilter(p, "i");
  expect(a).toMatchObject({ kind: "models", filter: "hai", index: 0 });
  const b = backspaceFilter(p);
  expect(b).toMatchObject({ kind: "models", filter: "h", index: 0 });
});
