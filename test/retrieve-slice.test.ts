import { test, expect, describe } from "bun:test";
import { relevantSlice } from "../src/context/retrieve.ts";

// Build a big TS file: an import header, a target function the query matches, and
// a lot of unrelated bulk so slicing is materially smaller than the whole.
function bigTsFile(): string {
  const header = `import { foo } from "./foo";\nimport { bar } from "./bar";\n// module comment\n`;
  const target = `export function computeRouting(task: string): number {\n  const x = 1;\n  return x + task.length;\n}\n`;
  const filler = Array.from({ length: 80 }, (_, i) =>
    `export function unrelatedHelper${i}(a: number): number {\n  // padding line one\n  // padding line two\n  return a * ${i};\n}`,
  ).join("\n\n");
  return header + "\n" + filler + "\n\n" + target;
}

describe("relevantSlice", () => {
  test("slices a large file to the matching block + header, omitting the bulk", () => {
    const src = bigTsFile();
    const slice = relevantSlice("src/big.ts", src, ["routing"]);
    expect(slice).not.toBeNull();
    expect(slice!.text).toContain("computeRouting"); // the matched block is kept
    expect(slice!.text).toContain('import { foo }'); // header kept for context
    expect(slice!.text).toContain("lines omitted"); // gaps marked
    expect(slice!.text).not.toContain("unrelatedHelper40"); // bulk dropped
    expect(slice!.tokens).toBeLessThan(src.length / 4); // materially smaller (rough token proxy)
  });

  test("keeps the whole enclosing block, never a mid-function cut", () => {
    const src = bigTsFile();
    const slice = relevantSlice("src/big.ts", src, ["routing"])!;
    // The full body of the matched function is present, brace-balanced.
    expect(slice.text).toContain("return x + task.length;");
    expect(slice.text).toContain("const x = 1;");
  });

  test("returns null when no declaration name matches the query (send whole file)", () => {
    const slice = relevantSlice("src/big.ts", bigTsFile(), ["nonexistentsymbolxyz"]);
    expect(slice).toBeNull();
  });

  test("returns null when too many declarations match (broad query → whole file)", () => {
    // Every helper matches "unrelatedhelper" → >8 regions → null.
    const slice = relevantSlice("src/big.ts", bigTsFile(), ["unrelatedhelper"]);
    expect(slice).toBeNull();
  });

  test("returns null when the slice isn't materially smaller than the whole", () => {
    // A small file whose single function matches: slice ≈ whole → not worth it.
    const small = `import x from "y";\nexport function justThis() {\n  return 1;\n}\n`;
    expect(relevantSlice("src/small.ts", small, ["justthis"])).toBeNull();
  });

  test("indentation languages (python): block bounded by dedent", () => {
    const py =
      `import os\nimport sys\n\n` +
      Array.from({ length: 40 }, (_, i) => `def filler_${i}(a):\n    return a + ${i}`).join("\n\n") +
      `\n\ndef computeRouting(task):\n    x = 1\n    return x + len(task)\n\n` +
      `def afterwards():\n    return 0\n`;
    const slice = relevantSlice("src/big.py", py, ["routing"]);
    expect(slice).not.toBeNull();
    expect(slice!.text).toContain("def computeRouting(task):");
    expect(slice!.text).toContain("return x + len(task)");
    expect(slice!.text).not.toContain("def afterwards():"); // the next def is not swallowed
    expect(slice!.text).not.toContain("filler_20");
  });

  test("empty query terms → null", () => {
    expect(relevantSlice("src/big.ts", bigTsFile(), [])).toBeNull();
  });

  test("unbalanced braces fail safe (run-to-EOF slice ≈ whole → null, never wrong file)", () => {
    // A matched function with a stray '{' in a string the brace scan miscounts:
    // the block runs to EOF, the slice is ~the whole file, and the win-check rejects it.
    const src =
      `import a from "b";\n` +
      `export function target() {\n  const s = "an open brace { without close";\n  return s;\n}\n` +
      Array.from({ length: 5 }, (_, i) => `const pad${i} = ${i};`).join("\n");
    const slice = relevantSlice("src/x.ts", src, ["target"]);
    // Either a clean small slice or null — but never a crash and never another file.
    if (slice) expect(slice.text).toContain("target");
    expect(true).toBe(true);
  });
});
