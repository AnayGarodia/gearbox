// Pure semantic-retrieval logic: cosine, index scoring, and the BM25 blend.
// Network paths (embedMany/embed) are not exercised here — semanticScores
// degrades to null without a provider, which is also asserted.
import { afterEach, describe, expect, test } from "bun:test";
import { cosine, scoreAgainstIndex, semanticScores, resetEmbeddingsCache } from "../src/context/embeddings.ts";
import { rankFiles, resetRetrievalIndex } from "../src/context/retrieve.ts";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invalidateFileListCache } from "../src/ui/files.ts";

afterEach(() => {
  resetEmbeddingsCache();
  resetRetrievalIndex();
  invalidateFileListCache();
});

describe("cosine", () => {
  test("identical, orthogonal, opposite, degenerate", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1);
    expect(cosine([0, 0], [1, 1])).toBe(0);
    expect(cosine([], [])).toBe(0);
  });
});

describe("scoreAgainstIndex", () => {
  test("scores every indexed file", () => {
    const idx = { files: { "a.ts": { vec: [1, 0] }, "b.ts": { vec: [0.6, 0.8] } } };
    const m = scoreAgainstIndex([1, 0], idx);
    expect(m.get("a.ts")).toBeCloseTo(1);
    expect(m.get("b.ts")).toBeCloseTo(0.6);
  });
});

describe("rankFiles semantic blend", () => {
  const setup = (): string => {
    // The file-list cache is global (not per-cwd) — a stale list from another
    // test file would make this cwd's files invisible to the indexer.
    invalidateFileListCache();
    resetRetrievalIndex();
    const cwd = mkdtempSync(join(tmpdir(), "gbx-emb-"));
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "alpha.ts"), "export function alphaThing() { return 1 }\n");
    writeFileSync(join(cwd, "src", "beta.ts"), "export function betaWidget() { return 2 }\n");
    return cwd;
  };

  test("a high-cosine file gains score additively; low cosine adds nothing", () => {
    const cwd = setup();
    try {
      // Relative assertions only: ambient state (retrieval priors from the
      // real ~/.gearbox, codegraph caches) can give beta a small baseline
      // score in a full-suite run, so absolute absence is not stable.
      const score = (rows: ReturnType<typeof rankFiles>, f: string) => rows.find((r) => r.file === f)?.score ?? 0;
      const pure = rankFiles("alphaThing usage", cwd);
      // Strong semantic score lifts beta strictly above its BM25 baseline.
      const sem = new Map([["src/beta.ts", 0.7], ["src/alpha.ts", 0.1]]);
      const blended = rankFiles("alphaThing usage", cwd, sem);
      expect(score(blended, "src/beta.ts")).toBeGreaterThan(score(pure, "src/beta.ts"));
      const beta = blended.find((r) => r.file === "src/beta.ts");
      // Semantic alone never grants the lexical "boosted" flag (no full push).
      expect(beta!.boosted).toBe(false);
      // alpha still ranks first: lexical match + path/symbol boosts dominate.
      expect(blended[0]!.file).toBe("src/alpha.ts");
      // Sub-threshold cosine adds nothing.
      const weak = rankFiles("alphaThing usage", cwd, new Map([["src/beta.ts", 0.2]]));
      expect(score(weak, "src/beta.ts")).toBeCloseTo(score(pure, "src/beta.ts"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("null/absent semantic map is exactly the BM25 path", () => {
    const cwd = setup();
    try {
      const a = rankFiles("alphaThing", cwd);
      const b = rankFiles("alphaThing", cwd, null);
      expect(b).toEqual(a);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("semanticScores degradation", () => {
  test("no index on disk → null (no throw, no network)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "gbx-emb-none-"));
    const prevHome = process.env.GEARBOX_HOME;
    process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gbx-home-"));
    try {
      expect(await semanticScores("anything", cwd)).toBeNull();
      expect(await semanticScores("anything", cwd, { prefs: { embeddings: false } })).toBeNull();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(process.env.GEARBOX_HOME!, { recursive: true, force: true });
      if (prevHome) process.env.GEARBOX_HOME = prevHome;
      else delete process.env.GEARBOX_HOME;
    }
  });
});
