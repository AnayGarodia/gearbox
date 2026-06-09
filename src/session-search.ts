/**
 * Cross-session search for Gearbox.
 *
 * Self-contained: no UI imports, no changes to session.ts. Scans the current
 * project's session directory (the same `${GEARBOX_HOME||~/.gearbox}/sessions/
 * <project-slug>/` layout session.ts writes), parses each session JSON, and
 * ranks matches for a case-insensitive query across the session title and the
 * user/assistant message text.
 *
 * Ranking model (see scoreOf):
 *   - field weight per query word: title (100) > user message (10) >
 *     assistant message (3) — a word counts at its BEST field only;
 *   - plus a small capped match-count bonus (more occurrences float up,
 *     but volume can never beat a better field);
 *   - ties broken by recency (newer `updatedAt` first), then id, so the
 *     ordering is fully deterministic.
 *
 * Multi-word queries use AND semantics: every word must appear somewhere in
 * the session (any field). The snippet shows the best line for the RAREST
 * word (fewest total occurrences) — the most discriminating term — with the
 * match centered ±SNIPPET_CONTEXT chars and ellipsized.
 *
 * Performance contract (this runs synchronously in a command handler):
 *   - files are read lazily, one at a time, newest mtime first;
 *   - scanning bails after `limit * SCAN_FACTOR` candidate files;
 *   - per-file work is capped (oversized files skipped entirely, text scan
 *     budgeted) so one giant session can't hang the UI.
 *
 * Corrupt or shape-invalid session files are skipped silently, mirroring
 * session.ts's best-effort reads.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Session } from "./session.ts";

/** One ranked search hit. */
export interface SessionMatch {
  id: string;
  title: string;
  updatedAt: number;
  /** Completed-turn count (session.turns.length). */
  turns: number;
  /** Best-matching line, match centered ±40 chars, ellipsized when clipped. */
  snippet: string;
  score: number;
}

// ── tuning constants ──────────────────────────────────────────────────────────

/** Default result cap when opts.limit is not given. */
const DEFAULT_LIMIT = 10;
/** Scan at most limit*SCAN_FACTOR files (newest mtime first) before bailing. */
const SCAN_FACTOR = 4;
/** Per-file text-scan budget (chars). A giant transcript is scanned partially. */
const MAX_SCAN_CHARS = 200_000;
/** Files larger than this are skipped outright — JSON.parse alone would stall. */
const MAX_FILE_BYTES = 16 * 1024 * 1024;
/** Chars of context kept on each side of the snippet's centered match. */
const SNIPPET_CONTEXT = 40;
/** Field weights, indexed by Field. Title beats user beats assistant. */
const FIELD_WEIGHT = [100, 10, 3] as const;
/**
 * Cap on the match-count bonus. Kept BELOW the smallest field-weight gap
 * (user 10 − assistant 3 = 7) so occurrence volume can refine the order
 * within a field but never flip the field ranking itself.
 */
const MAX_COUNT_BONUS = 6;

/** Field priority: lower index = higher rank. */
type Field = 0 | 1 | 2; // 0 = title, 1 = user message, 2 = assistant message

// ── project session dir ───────────────────────────────────────────────────────
//
// NOTE: session.ts does not export its `root`/`slug`/`dir` helpers, so the
// derivation is re-derived here IDENTICALLY (same regex, same fallback). If
// session.ts ever exports them, import instead and delete these three.

const sessionsRoot = () =>
  join(process.env.GEARBOX_HOME || join(homedir(), ".gearbox"), "sessions");

const projectSlug = () =>
  process.cwd().replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root";

const defaultDir = () => join(sessionsRoot(), projectSlug());

// ── query / text helpers ──────────────────────────────────────────────────────

/** Lowercased, deduped, whitespace-split query words. */
function splitWords(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
}

/** Plain text of one message: string content, or its `text` parts joined. */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const p of content) {
    if (
      p !== null &&
      typeof p === "object" &&
      (p as { type?: unknown }).type === "text" &&
      typeof (p as { text?: unknown }).text === "string"
    ) {
      parts.push((p as { text: string }).text);
    }
  }
  return parts.join("\n");
}

interface Doc {
  field: Field;
  lines: string[];
}

/**
 * Flattens a session into searchable docs (title + user/assistant messages),
 * spending at most MAX_SCAN_CHARS of text per session. Tool/system messages
 * and non-text parts are ignored.
 */
function extractDocs(s: Session): Doc[] {
  let budget = MAX_SCAN_CHARS;
  const docs: Doc[] = [];
  const push = (field: Field, text: string) => {
    if (budget <= 0 || !text) return;
    const t = text.length > budget ? text.slice(0, budget) : text;
    budget -= t.length;
    docs.push({ field, lines: t.split(/\r?\n/) });
  };
  if (typeof s.title === "string") push(0, s.title);
  const messages = Array.isArray(s.messages) ? s.messages : [];
  for (const m of messages) {
    if (budget <= 0) break;
    const role = (m as { role?: unknown })?.role;
    const field: Field | null = role === "user" ? 1 : role === "assistant" ? 2 : null;
    if (field === null) continue;
    push(field, messageText((m as { content?: unknown }).content));
  }
  return docs;
}

// ── per-session matching ──────────────────────────────────────────────────────

/** Best evidence found for one query word inside one session. */
interface WordStat {
  /** Total occurrences across all fields. */
  count: number;
  /** Best (lowest) field the word appeared in; 3 = not seen yet. */
  field: number;
  /** First matching line within that best field (original case). */
  line: string;
  /** Index of the first match inside `line`. */
  idx: number;
}

/** Counts occurrences of `word` in `lower`, returning [count, firstIndex]. */
function countIn(lower: string, word: string): [number, number] {
  let count = 0;
  let first = -1;
  let i = lower.indexOf(word);
  while (i !== -1) {
    if (first === -1) first = i;
    count++;
    i = lower.indexOf(word, i + 1);
  }
  return [count, first];
}

/**
 * Clips `line` to the match at [idx, idx+len) with ±SNIPPET_CONTEXT chars of
 * context, adding an ellipsis on each clipped side.
 */
function makeSnippet(line: string, idx: number, len: number): string {
  const start = Math.max(0, idx - SNIPPET_CONTEXT);
  const end = Math.min(line.length, idx + len + SNIPPET_CONTEXT);
  return (start > 0 ? "…" : "") + line.slice(start, end) + (end < line.length ? "…" : "");
}

/**
 * Scans one parsed session against the query words. Returns a SessionMatch
 * when EVERY word appears somewhere (AND semantics), else null.
 */
function matchSession(s: Session, words: string[]): SessionMatch | null {
  const stats: WordStat[] = words.map(() => ({ count: 0, field: 3, line: "", idx: -1 }));
  for (const doc of extractDocs(s)) {
    for (const line of doc.lines) {
      if (!line) continue;
      const lower = line.toLowerCase();
      for (let w = 0; w < words.length; w++) {
        const word = words[w]!;
        const [n, first] = countIn(lower, word);
        if (n === 0) continue;
        const stat = stats[w]!;
        stat.count += n;
        // Keep the FIRST line seen in the best field — deterministic, and
        // earlier conversation context tends to read better in a snippet.
        if (doc.field < stat.field) {
          stat.field = doc.field;
          stat.line = line;
          stat.idx = first;
        }
      }
    }
  }

  // AND semantics: every query word must appear somewhere in the session.
  if (stats.some((st) => st.count === 0)) return null;

  // Score: best-field weight per word + capped total-occurrence bonus.
  let base = 0;
  let total = 0;
  for (const st of stats) {
    base += FIELD_WEIGHT[st.field as Field];
    total += st.count;
  }
  const bonus = Math.min(total - words.length, MAX_COUNT_BONUS);
  const score = base + bonus;

  // Snippet: the rarest word's best line (ties → earlier query word).
  let rarest = 0;
  for (let w = 1; w < words.length; w++) {
    if (stats[w]!.count < stats[rarest]!.count) rarest = w;
  }
  const st = stats[rarest]!;
  const snippet = makeSnippet(st.line, st.idx, words[rarest]!.length);

  return {
    id: s.id,
    title: typeof s.title === "string" ? s.title : "",
    updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : 0,
    turns: Array.isArray(s.turns) ? s.turns.length : 0,
    snippet,
    score,
  };
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Searches the current project's saved sessions for `query`.
 *
 * Case-insensitive across title + user/assistant message text. Multi-word
 * queries require every word to appear somewhere in the session. Results are
 * sorted by score (title > user > assistant, match-count weighted), with
 * newer sessions floating up on score ties.
 *
 * @param opts.dir   override the session directory (defaults to this
 *                   project's `${GEARBOX_HOME||~/.gearbox}/sessions/<slug>`)
 * @param opts.limit max results (default 10); also bounds the file scan to
 *                   limit*4 candidates, newest mtime first
 */
export function searchSessions(
  query: string,
  opts: { dir?: string; limit?: number } = {},
): SessionMatch[] {
  const words = splitWords(query);
  if (words.length === 0) return [];
  const limit = Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT));
  const dir = opts.dir ?? defaultDir();

  // List candidate files with mtimes; newest first so the bail-early cap
  // drops the oldest (least likely wanted) sessions.
  let candidates: { path: string; mtime: number; size: number }[];
  try {
    candidates = readdirSync(dir)
      .filter((f) => f.endsWith(".json") && f !== "history.json")
      .flatMap((f) => {
        try {
          const path = join(dir, f);
          const st = statSync(path);
          return [{ path, mtime: st.mtimeMs, size: st.size }];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return []; // dir missing/unreadable → no sessions, not an error
  }

  const maxScan = limit * SCAN_FACTOR;
  const matches: SessionMatch[] = [];
  for (let i = 0; i < candidates.length && i < maxScan; i++) {
    const c = candidates[i]!;
    if (c.size > MAX_FILE_BYTES) continue; // refuse to parse a monster file
    let session: Session;
    try {
      // Lazy read: each file is only touched when its turn comes.
      const parsed: unknown = JSON.parse(readFileSync(c.path, "utf8"));
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        typeof (parsed as { id?: unknown }).id !== "string"
      ) {
        continue; // parses but isn't a session — skip silently
      }
      session = parsed as Session;
    } catch {
      continue; // corrupt file — skip silently
    }
    const m = matchSession(session, words);
    if (m) matches.push(m);
  }

  matches.sort(
    (a, b) =>
      b.score - a.score ||
      b.updatedAt - a.updatedAt ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return matches.slice(0, limit);
}

/**
 * Pure helper for the UI: every case-insensitive occurrence of each query
 * word inside `snippet`, as sorted, merged (non-overlapping) ranges the
 * renderer can bold. `end` is exclusive.
 */
export function highlightRanges(
  snippet: string,
  query: string,
): { start: number; end: number }[] {
  const words = splitWords(query);
  if (words.length === 0 || !snippet) return [];
  const lower = snippet.toLowerCase();
  const raw: { start: number; end: number }[] = [];
  for (const w of words) {
    let i = lower.indexOf(w);
    while (i !== -1) {
      raw.push({ start: i, end: i + w.length });
      i = lower.indexOf(w, i + 1);
    }
  }
  raw.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: { start: number; end: number }[] = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}
