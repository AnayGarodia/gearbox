import { test, expect } from "bun:test";
import { firstPath, uniq, shortFailure, backendKeyOf, isWriteLikeTool, previewLang, retrievalUseMeta } from "../src/ui/app-helpers.ts";

test("firstPath finds the first file-ish token", () => {
  expect(firstPath("open src/ui/App.tsx please")).toBe("src/ui/App.tsx");
  expect(firstPath("edit ./foo.bar and ./baz.qux")).toBe("./foo.bar");
  expect(firstPath("no paths here")).toBeNull();
});

test("uniq dedupes preserving first-seen order", () => {
  expect(uniq([3, 1, 3, 2, 1])).toEqual([3, 1, 2]);
  expect(uniq<string>([])).toEqual([]);
});

test("shortFailure classifies provider error text", () => {
  expect(shortFailure("HTTP 402 payment required")).toBe("out of credit");
  expect(shortFailure("Error 529: overloaded")).toBe("overloaded");
  expect(shortFailure("you hit your usage limit")).toBe("at its usage limit");
  expect(shortFailure("insufficient_quota")).toBe("out of quota");
  expect(shortFailure("session has ended, please re-authenticate")).toBe("expired");
  expect(shortFailure("401 unauthorized")).toBe("auth failed");
  expect(shortFailure("connection reset")).toBe("rate-limited");
});

test("backendKeyOf normalizes the backend identity", () => {
  expect(backendKeyOf(undefined)).toEqual({ kind: "in-loop", accountId: undefined });
  expect(backendKeyOf({ kind: "cli" } as any)).toEqual({ kind: "cli", accountId: undefined });
  expect(backendKeyOf({ kind: "api", account: { id: "acc1" } } as any)).toEqual({ kind: "api", accountId: "acc1" });
});

test("isWriteLikeTool matches mutating tools case-insensitively", () => {
  expect(isWriteLikeTool("write_file")).toBe(true);
  expect(isWriteLikeTool("EDIT_FILE")).toBe(true);
  expect(isWriteLikeTool("file_change")).toBe(true);
  expect(isWriteLikeTool("read_file")).toBe(false);
  expect(isWriteLikeTool("search")).toBe(false);
});

test("previewLang maps extensions to a language hint", () => {
  expect(previewLang("a/b/c.tsx")).toBe("tsx");
  expect(previewLang("script.py")).toBe("py");
  expect(previewLang("notes.unknownext")).toBe("unknownext");
});

test("retrievalUseMeta splits injected files into used/unused", () => {
  const retrieved = [
    { file: "src/a.ts", pointer: false },
    { file: "src/b.ts", pointer: false },
    { file: "src/p.ts", pointer: true }, // pointers are not 'injected'
  ];
  const produced = [
    { role: "assistant", content: [
      { type: "tool-call", input: { path: "src/a.ts" } }, // a touched by a tool
      { type: "text", text: "I also looked at b.ts for context" }, // b cited in prose
    ] },
  ] as any;
  const meta = retrievalUseMeta(retrieved, produced, process.cwd());
  expect(meta?.injected.sort()).toEqual(["src/a.ts", "src/b.ts"]);
  expect(meta?.used.sort()).toEqual(["src/a.ts", "src/b.ts"]);
  expect(meta?.unused).toEqual(["src/b.ts"]); // unused = not touched by a tool
});

test("retrievalUseMeta returns undefined with no injected files", () => {
  expect(retrievalUseMeta([{ file: "x", pointer: true }], [], process.cwd())).toBeUndefined();
});
