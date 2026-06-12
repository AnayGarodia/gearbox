// Pure logic for symbol navigation: position anchoring, LSP result
// normalization, display formatting. Live server round-trips are in
// lsp-symbols-integration.test.ts (skipped when no server is installed).
import { describe, expect, test } from "bun:test";
import { findSymbolPosition, formatLocations } from "../src/lsp/symbols.ts";
import { normalizeLocations } from "../src/lsp/client.ts";

describe("findSymbolPosition", () => {
  const src = [
    "import { foo } from './foo.ts'", // 1
    "const bar = foo + 1",            // 2
    "export function foo2() {}",      // 3
    "function foo(n: number) {}",     // 4
  ].join("\n");

  test("prefers a definition-keyword occurrence over the first occurrence", () => {
    expect(findSymbolPosition(src, "foo")).toEqual({ line: 4, col: 10 });
  });
  test("nearLine wins when the symbol is on it", () => {
    expect(findSymbolPosition(src, "foo", 2)).toEqual({ line: 2, col: 13 });
  });
  test("falls back to first whole-word occurrence; no substring matches", () => {
    expect(findSymbolPosition(src, "bar")).toEqual({ line: 2, col: 7 });
    // "foo2" must not match as "foo" — whole-word boundaries.
    expect(findSymbolPosition("let a = foo2", "foo")).toBeNull();
  });
  test("missing symbol or empty input yields null", () => {
    expect(findSymbolPosition(src, "nope")).toBeNull();
    expect(findSymbolPosition(src, "")).toBeNull();
  });
});

describe("normalizeLocations", () => {
  test("single Location, Location[], and LocationLink[] all normalize to 1-based", () => {
    const loc = { uri: "file:///ws/a.ts", range: { start: { line: 4, character: 2 } } };
    expect(normalizeLocations(loc)).toEqual([{ path: "/ws/a.ts", line: 5, col: 3 }]);
    expect(normalizeLocations([loc, loc])).toHaveLength(2);
    const link = { targetUri: "file:///ws/b.ts", targetSelectionRange: { start: { line: 0, character: 0 } } };
    expect(normalizeLocations([link])).toEqual([{ path: "/ws/b.ts", line: 1, col: 1 }]);
  });
  test("null, garbage, and non-file uris degrade safely", () => {
    expect(normalizeLocations(null)).toEqual([]);
    expect(normalizeLocations([{ no: "uri" }, 42, "x"])).toEqual([]);
    expect(normalizeLocations([{ uri: "untitled:Untitled-1", range: { start: { line: 0, character: 0 } } }])).toEqual([
      { path: "untitled:Untitled-1", line: 1, col: 1 },
    ]);
  });
});

describe("formatLocations", () => {
  test("relativizes under cwd, keeps text, caps with a more-line", () => {
    const locs = Array.from({ length: 5 }, (_, i) => ({ path: "/ws/src/a.ts", line: i + 1, col: 1, text: `line ${i + 1}` }));
    const out = formatLocations(locs, 3, "/ws");
    expect(out).toContain("src/a.ts:1:1  line 1");
    expect(out).toContain("… and 2 more");
    expect(out.split("\n")).toHaveLength(4);
  });
  test("empty input yields empty string", () => {
    expect(formatLocations([], 10, "/ws")).toBe("");
  });
});
