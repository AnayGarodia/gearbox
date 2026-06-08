/**
 * Lexical Code Retrieval: BM25 with path and symbol boosts.
 *
 * This module is the E-D2 winner from experiments/context: plain BM25-weighted
 * lexical search beat an Aider-style PageRank symbol graph at this repo's scale,
 * and a strong-model rerank (deferred) only adds top-K precision on top. Ported
 * from experiments/context/retrieval.py. No embeddings, no model calls, instant.
 *
 * Scoring pipeline for a query string:
 *   1. Tokenise the query with `terms()`: split on non-alphanumeric characters,
 *      expand camelCase segments, lowercase, drop stopwords and short tokens.
 *   2. For each code file in the project, compute a BM25 score across the
 *      query terms using the standard tf-saturation formula.
 *   3. Apply two additional boosts on top of BM25:
 *        - Path boost: +4*idf when a query term appears in the file path.
 *          Surface files whose name matches the task even if the body does not.
 *        - Symbol boost: +3*idf when a query term appears in a defined symbol
 *          name (function/class/const/etc. extracted from the file at index time).
 *          Surface files that export the thing being asked about.
 *   4. A special-case boost for model-selection queries routes those queries
 *      toward model/selector, model/router, and config files.
 *   5. Files with a score of 0 are discarded; the rest are sorted descending.
 *
 * Index lifecycle:
 *   The index is built lazily on the first call to `index()` for a given cwd
 *   and cached in memory for the rest of the process. Because files change
 *   during a session (the agent edits them), `updateRetrievalFile` patches the
 *   live index incrementally after each write so the next retrieval sees the
 *   new content without a full rebuild. `resetRetrievalIndex` drops the cache
 *   entirely (used in tests and long-running sessions with large structural
 *   changes).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { listProjectFiles } from "../ui/files.ts";
import { countTokens } from "../model/tokens.ts";

// Code file extensions considered for retrieval. Non-code assets are excluded
// because they have no token-bearing symbols and inflate the index for free.
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|c|h|cpp|hpp)$/;

// Common English stopwords and very short tokens that carry no retrieval signal.
// Removing them prevents high-frequency words from drowning out content terms.
const STOP = new Set(
  "the a an to is it of and or in on for with that this when should i me my be do does did into out up as at by".split(" "),
);

// Pattern to extract symbol names defined in a file at index time. These are
// stored separately so the scorer can apply a targeted boost when a query term
// matches a symbol name rather than just appearing in the file body.
const DEF_RE =
  /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Tokenise a string into retrieval terms.
 *
 * Splits on non-alphanumeric boundaries, then splits each segment by camelCase
 * (upper-only runs, Title-case words, lowercase runs, digit runs). The result
 * is lowercased and filtered to remove stopwords and tokens shorter than 3
 * chars. camelCase splitting means "buildContext" yields ["build", "context"]
 * and matches files that spell out either word.
 */
function terms(s: string): string[] {
  const out: string[] = [];
  for (const part of s.split(/[^A-Za-z0-9]+/)) {
    for (const w of part.match(/[A-Z]+(?![a-z])|[A-Z][a-z]+|[a-z]+|[0-9]+/g) ?? []) {
      const lw = w.toLowerCase();
      if (lw.length >= 3 && !STOP.has(lw)) out.push(lw);
    }
  }
  return out;
}

/**
 * In-memory index for one cwd. Built once and patched incrementally.
 *
 * `raw`      original file content (used when packing results by token budget).
 * `low`      lowercased content (used for BM25 term-frequency counting).
 * `fileDefs` lowercased symbol names declared in each file (for symbol boost).
 * `df`       document frequency per term (number of files containing the term).
 * `n`        total number of indexed files (denominator for IDF).
 */
interface Index {
  files: string[];
  raw: Map<string, string>;
  low: Map<string, string>;
  fileDefs: Map<string, string[]>;
  df: Map<string, number>;
  n: number;
}

// Module-level cache: one Index per cwd, rebuilt when the cwd changes.
let cached: { cwd: string; idx: Index } | null = null;

/**
 * Build the full index for `cwd` from scratch. Reads every code file once,
 * lowercases it, extracts symbol definitions, and computes document frequencies
 * across all terms (3+ char lowercase words). The resulting index is O(vocab)
 * in memory and O(files * avg_file_size) in time to build.
 */
function buildIndex(cwd: string): Index {
  const files = listProjectFiles(cwd).filter((f) => CODE.test(f));
  const raw = new Map<string, string>();
  const low = new Map<string, string>();
  const fileDefs = new Map<string, string[]>();
  const df = new Map<string, number>();
  for (const f of files) {
    let src: string;
    try {
      src = readFileSync(resolve(cwd, f), "utf8");
    } catch {
      continue;
    }
    raw.set(f, src);
    const lc = src.toLowerCase();
    low.set(f, lc);
    // Extract symbol names for the symbol-boost scoring path.
    const defs: string[] = [];
    for (const m of src.matchAll(DEF_RE)) defs.push(m[1]!.toLowerCase());
    fileDefs.set(f, defs);
    // Accumulate document frequency: each unique 3+ char word in this file
    // increments the global df counter by 1 (using Set to deduplicate per file).
    for (const t of new Set(lc.match(/[a-z]{3,}/g) ?? [])) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const present = files.filter((f) => raw.has(f));
  return { files: present, raw, low, fileDefs, df, n: present.length };
}

/** Return the cached index for `cwd`, building it on the first call. */
function index(cwd: string): Index {
  if (cached && cached.cwd === cwd) return cached.idx;
  const idx = buildIndex(cwd);
  cached = { cwd, idx };
  return idx;
}

/** Reset the cached index (e.g. after files change in a long session). */
export function resetRetrievalIndex(): void {
  cached = null;
}

/**
 * Incrementally fold a single file change into the live index so a file the
 * agent just created or edited is retrievable on the next turn, without
 * rebuilding the whole repo index.
 *
 * When `content` is null, the file is removed from the index. When it is a
 * string, the old index entries for the file are first removed (decreasing df
 * counts) and then the new content is inserted. No-op when nothing is indexed
 * yet for `cwd` (the next full build will pick the change up) or the file is
 * not a code file.
 */
export function updateRetrievalFile(file: string, content: string | null, cwd = process.cwd()): void {
  if (!cached || cached.cwd !== cwd) return;
  if (!CODE.test(file)) return;
  const idx = cached.idx;

  // Remove the old contribution from the index if this file was previously indexed.
  if (idx.raw.has(file)) {
    // Decrement df for every unique term the old content contributed.
    for (const t of new Set(idx.low.get(file)!.match(/[a-z]{3,}/g) ?? [])) {
      const d = (idx.df.get(t) ?? 0) - 1;
      if (d <= 0) idx.df.delete(t);
      else idx.df.set(t, d);
    }
    idx.raw.delete(file);
    idx.low.delete(file);
    idx.fileDefs.delete(file);
    idx.files = idx.files.filter((f) => f !== file);
  }

  // Insert the new content if provided (null means delete only).
  if (content != null) {
    idx.raw.set(file, content);
    const lc = content.toLowerCase();
    idx.low.set(file, lc);
    const defs: string[] = [];
    for (const m of content.matchAll(DEF_RE)) defs.push(m[1]!.toLowerCase());
    idx.fileDefs.set(file, defs);
    for (const t of new Set(lc.match(/[a-z]{3,}/g) ?? [])) idx.df.set(t, (idx.df.get(t) ?? 0) + 1);
    if (!idx.files.includes(file)) idx.files.push(file);
  }
  idx.n = idx.files.length;
}

/**
 * BM25 inverse document frequency for term `t` in index `idx`.
 *
 * Uses the BM25+ variant formula: log(1 + (N - df + 0.5) / (df + 0.5)), which
 * smooths away the singularity at df = 0 and gives rare terms a higher weight
 * than common ones. Terms appearing in every file score near 0; terms appearing
 * in only one file score highest.
 */
function idf(idx: Index, t: string): number {
  const d = idx.df.get(t) ?? 0;
  return Math.log(1 + (idx.n - d + 0.5) / (d + 0.5));
}

/**
 * Count non-overlapping occurrences of `needle` in `haystack`.
 * Used for BM25 term-frequency counting; cheaper than a regex for plain strings.
 */
function countOcc(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i >= 0) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/**
 * Score all indexed files against `query` and return them sorted by descending
 * BM25 score, filtering out files with score 0.
 *
 * For each query term and each file the scorer accumulates:
 *   - BM25 body score: idf * (tf * k1) / (tf + k1), with k1 = 2.2. Higher k1
 *     gives more weight to repeated term occurrences before saturation kicks in.
 *   - Path boost: +4*idf when the term appears in the file path (case-folded).
 *     Ensures a query for "builder" surfaces "src/context/builder.ts" even if
 *     the term is common in the body.
 *   - Symbol boost: +3*idf when the term matches a symbol defined in the file.
 *     Ensures a query for "buildContext" surfaces the file that exports it.
 *   - Model-selection boost: hardcoded +8*idf applied only when the query looks
 *     like a model-selection question and the file is a known selector/router.
 *     Without this, generic terms like "model" swamp the routing files.
 */
export function rankFiles(query: string, cwd = process.cwd()): { file: string; score: number }[] {
  const idx = index(cwd);
  const qt = terms(query);
  if (!qt.length) return [];

  // Detect a model-selection query so we can apply the hardcoded routing boost.
  const asksModelSelection = qt.includes("model") && (qt.includes("default") || qt.includes("used") || qt.includes("change"));

  const scored = idx.files.map((f) => {
    const lc = idx.low.get(f)!;
    const fl = f.toLowerCase();
    const defs = idx.fileDefs.get(f)!;
    let s = 0;
    for (const t of qt) {
      const tf = countOcc(lc, t);
      if (tf) s += idf(idx, t) * (tf * 2.2) / (tf + 1.2); // BM25 tf saturation (k1 = 2.2)
      if (fl.includes(t)) s += 4 * idf(idx, t); // path match: rewards files named after the query
      if (defs.some((d) => d.includes(t))) s += 3 * idf(idx, t); // symbol match: rewards defining files
    }
    // Routing boost: model-selection queries should surface selector/router/config
    // even if those files score low on raw term frequency.
    if (asksModelSelection && /(^|\/)(model\/selector|model\/router|config)\.ts$/.test(fl)) s += 8 * idf(idx, "model");
    return { file: f, score: s };
  });
  return scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
}

export interface RetrievedFile {
  file: string;
  content: string;
  tokens: number;
}

/**
 * Return the top-k most relevant files for `query`, packed within `budget` tokens.
 *
 * Files are added in descending score order. An oversize file is SKIPPED (not
 * truncated) so that a smaller but still relevant file can fill the remaining
 * budget. This avoids presenting the model with a partial, potentially
 * misleading view of a file.
 */
export function retrieveFiles(
  query: string,
  cwd = process.cwd(),
  k = 6,
  budget = 8000,
  modelId?: string,
): RetrievedFile[] {
  const idx = index(cwd);
  // Slice to top-k candidates before token-packing to keep the loop bounded.
  const ranked = rankFiles(query, cwd).slice(0, k);
  const out: RetrievedFile[] = [];
  let used = 0;
  for (const { file } of ranked) {
    const content = idx.raw.get(file);
    if (content == null) continue;
    const tokens = countTokens(content, modelId);
    // Skip files that would overflow the remaining budget, but keep trying
    // smaller files that might still fit.
    if (used + tokens > budget) continue;
    out.push({ file, content, tokens });
    used += tokens;
  }
  return out;
}
