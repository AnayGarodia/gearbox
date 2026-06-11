import { test, expect, describe } from "bun:test";
import { rankFiles, updateRetrievalFile, resetRetrievalIndex } from "../src/context/retrieve.ts";

// A term unlikely to occur anywhere in the real repo, so a hit proves the
// incremental update landed (not a pre-existing file). Assembled at runtime so the
// contiguous literal never appears in THIS file's source (which git indexes).
const UNIQ = ["zzqx", "unicorn", "probe", "tok"].join("");
const FAKE = "src/__fake_retrieve_probe__.ts";
const CALLER = "src/__fake_retrieve_caller__.ts";

describe("updateRetrievalFile (incremental index freshness)", () => {
  test("a newly created file becomes retrievable without a full rebuild", () => {
    rankFiles("anything"); // ensure the index is built for the real cwd
    expect(rankFiles(UNIQ).length).toBe(0); // not present yet

    updateRetrievalFile(FAKE, `export const ${UNIQ} = 1;\n`);
    const hit = rankFiles(UNIQ);
    expect(hit.some((r) => r.file === FAKE)).toBe(true);
  });

  test("deleting a file (content=null) removes it from results", () => {
    updateRetrievalFile(FAKE, `export const ${UNIQ} = 1;\n`);
    expect(rankFiles(UNIQ).some((r) => r.file === FAKE)).toBe(true);
    updateRetrievalFile(FAKE, null);
    expect(rankFiles(UNIQ).some((r) => r.file === FAKE)).toBe(false);
  });

  test("updating content reflects the new text", () => {
    updateRetrievalFile(FAKE, `export const before = 1;\n`);
    expect(rankFiles(UNIQ).some((r) => r.file === FAKE)).toBe(false);
    updateRetrievalFile(FAKE, `export const ${UNIQ} = 2;\n`);
    expect(rankFiles(UNIQ).some((r) => r.file === FAKE)).toBe(true);
    updateRetrievalFile(FAKE, null); // cleanup
  });

  test("ignores non-code files", () => {
    updateRetrievalFile("notes.md", `${UNIQ} ${UNIQ}\n`);
    expect(rankFiles(UNIQ).some((r) => r.file === "notes.md")).toBe(false);
  });

  test("is a no-op (no throw) when nothing is indexed for the cwd", () => {
    resetRetrievalIndex();
    expect(() => updateRetrievalFile(FAKE, `x ${UNIQ}\n`)).not.toThrow();
  });

  test("reference/import signals surface usage files for caller queries", () => {
    rankFiles("anything"); // rebuild after the reset above
    updateRetrievalFile(FAKE, `export function ${UNIQ}() { return 1; }\n`);
    updateRetrievalFile(CALLER, `import { ${UNIQ} } from "./__fake_retrieve_probe__";\nexport const useIt = ${UNIQ}();\n`);
    const ranked = rankFiles(`callers of ${UNIQ}`);
    expect(ranked.some((r) => r.file === CALLER && r.boosted)).toBe(true);
    updateRetrievalFile(FAKE, null);
    updateRetrievalFile(CALLER, null);
  });
});
