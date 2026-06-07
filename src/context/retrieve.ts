// Lexical code retrieval (BM25 + path/symbol boosts). This is the E-D2 winner
// from experiments/context: plain BM25-weighted lexical search beat an Aider-style
// PageRank symbol graph at this repo's scale, and a strong-model rerank (deferred)
// only adds top-K precision on top. Ported from experiments/context/retrieval.py.
// No embeddings, no model call — instant and free.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { listProjectFiles } from "../ui/files.ts";
import { countTokens } from "../model/tokens.ts";

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|c|h|cpp|hpp)$/;
const STOP = new Set(
  "the a an to is it of and or in on for with that this when should i me my be do does did into out up as at by".split(" "),
);
// export/function/class/interface/type/const/enum NAME — the symbol a file defines.
const DEF_RE =
  /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/g;

// Split a query into content terms: camelCase-aware, lowercased, no stopwords/short.
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

interface Index {
  files: string[];
  raw: Map<string, string>;
  low: Map<string, string>;
  fileDefs: Map<string, string[]>; // lowercased symbol names per file
  df: Map<string, number>; // document frequency per term
  n: number;
}

let cached: { cwd: string; idx: Index } | null = null;

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
    const defs: string[] = [];
    for (const m of src.matchAll(DEF_RE)) defs.push(m[1]!.toLowerCase());
    fileDefs.set(f, defs);
    for (const t of new Set(lc.match(/[a-z]{3,}/g) ?? [])) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const present = files.filter((f) => raw.has(f));
  return { files: present, raw, low, fileDefs, df, n: present.length };
}

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
 * Incrementally fold a single file change into the live index so a file the agent
 * just created/edited is retrievable on the next turn — without rebuilding the
 * whole repo index. `content === null` removes the file. No-op when nothing is
 * indexed yet for `cwd` (the next full build will pick the change up) or the file
 * isn't a code file.
 */
export function updateRetrievalFile(file: string, content: string | null, cwd = process.cwd()): void {
  if (!cached || cached.cwd !== cwd) return;
  if (!CODE.test(file)) return;
  const idx = cached.idx;
  // Remove the old contribution (df, maps, file list) if we had this file.
  if (idx.raw.has(file)) {
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

function idf(idx: Index, t: string): number {
  const d = idx.df.get(t) ?? 0;
  return Math.log(1 + (idx.n - d + 0.5) / (d + 0.5));
}

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

/** BM25-weighted lexical score per file, highest first (score > 0 only). */
export function rankFiles(query: string, cwd = process.cwd()): { file: string; score: number }[] {
  const idx = index(cwd);
  const qt = terms(query);
  if (!qt.length) return [];
  const asksModelSelection = qt.includes("model") && (qt.includes("default") || qt.includes("used") || qt.includes("change"));
  const scored = idx.files.map((f) => {
    const lc = idx.low.get(f)!;
    const fl = f.toLowerCase();
    const defs = idx.fileDefs.get(f)!;
    let s = 0;
    for (const t of qt) {
      const tf = countOcc(lc, t);
      if (tf) s += idf(idx, t) * (tf * 2.2) / (tf + 1.2); // BM25 tf saturation
      if (fl.includes(t)) s += 4 * idf(idx, t); // path match (idf-scaled)
      if (defs.some((d) => d.includes(t))) s += 3 * idf(idx, t); // symbol-name match
    }
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
 * Top relevant files for `query`, packed within `budget` tokens (most-relevant
 * first; oversize files are skipped so a smaller relevant file can still fit).
 */
export function retrieveFiles(
  query: string,
  cwd = process.cwd(),
  k = 6,
  budget = 8000,
  modelId?: string,
): RetrievedFile[] {
  const idx = index(cwd);
  const ranked = rankFiles(query, cwd).slice(0, k);
  const out: RetrievedFile[] = [];
  let used = 0;
  for (const { file } of ranked) {
    const content = idx.raw.get(file);
    if (content == null) continue;
    const tokens = countTokens(content, modelId);
    if (used + tokens > budget) continue;
    out.push({ file, content, tokens });
    used += tokens;
  }
  return out;
}
