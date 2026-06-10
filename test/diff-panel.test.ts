// Pure reducers behind the full diff view (/diff panel): open, move, lazy text
// delivery, scrolling, row formatting.
import { test, expect } from "bun:test";
import { diffOpen, diffMove, diffSetText, diffScroll, diffFileRow } from "../src/ui/panel.ts";
import type { DiffFileEntry } from "../src/git/ops.ts";

const files: DiffFileEntry[] = [
  { path: "src/a.ts", additions: 84, deletions: 12, status: "modified", binary: false },
  { path: "src/new.ts", additions: 28, deletions: 0, status: "added", binary: false },
  { path: "gone.ts", additions: 0, deletions: 40, status: "deleted", binary: false },
];

test("diffOpen titles with totals and scope; empty set says none", () => {
  const p = diffOpen(files, "abc123", "session");
  expect(p.title).toBe("changes · 3 files · +112 −52 · session");
  expect(p.index).toBe(0);
  expect(p.diff).toBeNull();
  expect(diffOpen([], null, "session").title).toBe("changes · none · session");
});

test("diffMove clamps, invalidates the loaded diff, and resets scroll", () => {
  let p = diffSetText(diffOpen(files, null, "session"), "@@ -1 +1 @@\n+x");
  p = diffScroll(p, 1, 1);
  const moved = diffMove(p, 1);
  expect(moved.index).toBe(1);
  expect(moved.diff).toBeNull();
  expect(moved.scroll).toBe(0);
  expect(diffMove(moved, 99).index).toBe(2);
  expect(diffMove(diffOpen(files, null, "s"), -5).index).toBe(0);
  // No-op move keeps the object (and its loaded diff) intact.
  const pinned = diffSetText(diffMove(p, -99), "text");
  expect(diffMove(pinned, -1)).toBe(pinned);
});

test("diffScroll clamps to content lines minus the view height", () => {
  const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
  let p = diffSetText(diffOpen(files, null, "s"), text);
  p = diffScroll(p, 100, 4);
  expect(p.scroll).toBe(6); // 10 lines − 4 view
  p = diffScroll(p, -100, 4);
  expect(p.scroll).toBe(0);
  expect(diffScroll({ ...p, diff: null }, 5, 4).scroll).toBe(0); // nothing loaded → pinned
});

test("diffFileRow right-aligns counts and tags non-modified states", () => {
  const row = diffFileRow(files[1]!, 40);
  expect(row.length).toBeLessThanOrEqual(40);
  expect(row).toContain("src/new.ts");
  expect(row.trimEnd().endsWith("added")).toBe(true);
  expect(diffFileRow(files[0]!, 40)).toContain("+84 −12");
  const bin = diffFileRow({ path: "img.png", additions: 0, deletions: 0, status: "modified", binary: true }, 40);
  expect(bin).toContain("binary");
});
