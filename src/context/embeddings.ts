// Semantic retrieval layer: a disk-cached embedding index per repo, blended
// into BM25 ranking as a RERANK signal (retrieve.ts). Design constraints:
//
//   · The HOT PATH stays cheap: ranking never builds the index. The only
//     network on a turn is ONE query embedding, bounded by a short timeout —
//     on timeout/failure/no-provider the caller gets null and retrieval is
//     pure BM25, exactly as before. BM25 stays the floor, never replaced.
//   · The index builds in the BACKGROUND (refreshEmbeddingsIndex, fired from
//     App once per session) and is incremental: only new/changed files (by
//     content hash) are re-embedded. Cost is tiny (a repo of 2 000 files ≈
//     $0.04 once on text-embedding-3-small, $0 on Google) but real, and the
//     build SENDS FILE CONTENTS to the embedding provider — so the layer is
//     OPT-IN (prefs.embeddings === true via /config embeddings on; review).
//     Every embedding call records through the ledger's single spend writer.
//   · Pure math (cosine, blending) is exported separately for fixture tests.
//
// Index file: ~/.gearbox/embeddings/<repo-slug>.json
//   { model, files: { [relPath]: { hash, vec } } }
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { embedMany, embed } from "ai";
import { embeddingModelFor } from "../providers.ts";
import { recordSpend } from "../accounts/ledger.ts";
import { listProjectFiles } from "../ui/files.ts";

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|c|h|cpp|hpp)$/;
/** Max files per repo and max chars embedded per file — cost + memory caps. */
const MAX_FILES = 2000;
const HEAD_CHARS = 4000;
const BATCH = 64;

interface IndexFile {
  model: string;
  files: Record<string, { hash: string; vec: number[] }>;
}

const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

/** Spend truth: embedding tokens flow through the SAME single writer as every
 *  other dollar (ledger invariant) — /usage, /cost and /cap stay honest. */
function recordEmbedSpend(backend: { provider: string; modelId: string; usdPerMtok: number }, tokens: number): void {
  try {
    recordSpend({
      accountId: `env:${backend.provider}`,
      model: backend.modelId,
      source: "aux",
      inputTokens: tokens,
      outputTokens: 0,
      costUSD: (tokens / 1_000_000) * backend.usdPerMtok,
      estimated: false,
      at: Date.now(),
    });
  } catch {
    /* spend recording must never break retrieval */
  }
}

function home(): string {
  return process.env.GEARBOX_HOME || join(homedir(), ".gearbox");
}

/** Mirror of session.ts's project slug shape: stable, filesystem-safe. */
function slugFor(cwd: string): string {
  const real = resolve(cwd);
  return `${real.split("/").filter(Boolean).slice(-2).join("-").replace(/[^A-Za-z0-9_-]/g, "_")}-${sha(real).slice(0, 8)}`;
}

function indexPath(cwd: string): string {
  return join(home(), "embeddings", `${slugFor(cwd)}.json`);
}

// In-memory cache of the loaded index per cwd (read once per process; the
// background refresh updates both disk and this cache).
let cached: { cwd: string; idx: IndexFile } | null = null;

function loadIndex(cwd: string): IndexFile | null {
  if (cached && cached.cwd === cwd) return cached.idx;
  try {
    const idx = JSON.parse(readFileSync(indexPath(cwd), "utf8")) as IndexFile;
    if (!idx || typeof idx.files !== "object") return null;
    cached = { cwd, idx };
    return idx;
  } catch {
    return null;
  }
}

function saveIndex(cwd: string, idx: IndexFile): void {
  const p = indexPath(cwd);
  mkdirSync(join(home(), "embeddings"), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(idx));
  renameSync(tmp, p); // crash-safe, same pattern as usage.json
  cached = { cwd, idx };
}

/** What a file contributes to its embedding: path header + content head. */
function embedText(relPath: string, content: string): string {
  return `${relPath}\n${content.slice(0, HEAD_CHARS)}`;
}

export const cosine = (a: number[], b: number[]): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

/** Is the semantic layer usable here (pref on + provider configured)? */
export function embeddingsEnabled(prefs: { embeddings?: boolean } = {}): boolean {
  if (prefs.embeddings === false) return false;
  return embeddingModelFor() !== null;
}

/**
 * Background index build/refresh: embed new and changed code files, drop
 * deleted ones. Incremental by content hash; batched; never throws. Returns
 * counts for the caller's notice line ({embedded: 0} = nothing to do).
 */
export async function refreshEmbeddingsIndex(
  cwd: string,
  opts: { prefs?: { embeddings?: boolean }; maxFiles?: number } = {},
): Promise<{ embedded: number; total: number; note?: string }> {
  try {
    // OPT-IN: building the index uploads file heads to the embedding provider.
    if (opts.prefs?.embeddings !== true) return { embedded: 0, total: 0, note: "embeddings off — /config embeddings on to enable" };
    const backend = embeddingModelFor();
    if (!backend) return { embedded: 0, total: 0, note: "no embedding-capable provider configured" };

    const files = listProjectFiles(cwd).filter((f) => CODE.test(f)).slice(0, opts.maxFiles ?? MAX_FILES);
    const idx: IndexFile = loadIndex(cwd) ?? { model: backend.modelId, files: {} };
    if (idx.model !== backend.modelId) idx.files = {}; // model changed → vectors incomparable
    idx.model = backend.modelId;

    const want = new Map<string, { hash: string; text: string }>();
    for (const f of files) {
      let src: string;
      try {
        src = readFileSync(resolve(cwd, f), "utf8");
      } catch {
        continue;
      }
      const text = embedText(f, src);
      const hash = sha(text);
      if (idx.files[f]?.hash !== hash) want.set(f, { hash, text });
    }
    // Drop entries for files that no longer exist.
    const present = new Set(files);
    for (const f of Object.keys(idx.files)) if (!present.has(f)) delete idx.files[f];

    const todo = [...want.entries()];
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH);
      const { embeddings, usage } = await embedMany({ model: backend.model, values: batch.map(([, v]) => v.text) });
      recordEmbedSpend(backend, usage?.tokens ?? batch.reduce((a, [, v]) => a + Math.ceil(v.text.length / 4), 0));
      batch.forEach(([f, v], j) => {
        const vec = embeddings[j];
        if (vec) idx.files[f] = { hash: v.hash, vec: [...vec] };
      });
      saveIndex(cwd, idx); // checkpoint per batch so an abort keeps progress
    }
    if (todo.length === 0) saveIndex(cwd, idx); // persist deletions even with nothing to embed
    return { embedded: todo.length, total: Object.keys(idx.files).length };
  } catch (e) {
    return { embedded: 0, total: 0, note: `embedding refresh failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * The hot-path half: embed the query (ONE small network call, hard-capped by
 * `timeoutMs`) and return per-file cosine similarity against the cached index.
 * null on any miss — no provider, no index yet, pref off, timeout, error —
 * so the caller's BM25 path is untouched.
 */
// Memo of the last query's scores: the failover hop-loop may rebuild context
// for the SAME prompt on a different model — one embedding call per turn.
let lastQuery: { query: string; cwd: string; result: Map<string, number> | null } | null = null;

export async function semanticScores(
  query: string,
  cwd: string,
  opts: { timeoutMs?: number; prefs?: { embeddings?: boolean } } = {},
): Promise<Map<string, number> | null> {
  try {
    if (opts.prefs?.embeddings !== true) return null; // opt-in, same gate as the index build
    if (lastQuery && lastQuery.query === query && lastQuery.cwd === cwd) return lastQuery.result;
    const idx = loadIndex(cwd);
    if (!idx || Object.keys(idx.files).length === 0) return null;
    const backend = embeddingModelFor();
    if (!backend || backend.modelId !== idx.model) return null;

    const timeoutMs = opts.timeoutMs ?? 800;
    const q = await Promise.race([
      embed({ model: backend.model, value: query.slice(0, HEAD_CHARS) }).then((r) => {
        recordEmbedSpend(backend, r.usage?.tokens ?? Math.ceil(Math.min(query.length, HEAD_CHARS) / 4));
        return r.embedding;
      }),
      new Promise<null>((res) => setTimeout(() => res(null), timeoutMs)),
    ]);
    const result = q ? scoreAgainstIndex([...q], idx) : null;
    // Memo even a null timeout result: retrying the embed on every hop of the
    // same turn would add latency exactly when the turn is already struggling.
    lastQuery = { query, cwd, result };
    return result;
  } catch {
    return null;
  }
}

/** Pure: cosine of a query vector against every indexed file. Fixture-tested. */
export function scoreAgainstIndex(queryVec: number[], idx: { files: Record<string, { vec: number[] }> }): Map<string, number> {
  const out = new Map<string, number>();
  for (const [f, { vec }] of Object.entries(idx.files)) out.set(f, cosine(queryVec, vec));
  return out;
}

/** Test seam: drop the in-memory caches. */
export function resetEmbeddingsCache(): void {
  cached = null;
  lastQuery = null;
}
