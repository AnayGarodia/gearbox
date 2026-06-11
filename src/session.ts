/**
 * Session persistence for Gearbox.
 *
 * Each project gets its own subdirectory under GEARBOX_HOME/sessions (default
 * ~/.gearbox/sessions). The subdirectory name is a URL-safe slug derived from
 * the current working directory, so different projects never share state.
 *
 * Slug format: process.cwd() with every run of non-alphanumeric characters
 * replaced by a single hyphen, leading/trailing hyphens stripped, and the
 * string "root" used as a fallback when the result would be empty (e.g. when
 * cwd is "/").
 *
 * Per-turn storage layout (inside a session JSON file):
 *   messages  -- provider-neutral AI SDK ModelMessage array; the full context
 *                window sent on every call. Stored without model-specific
 *                envelope so it works with any future provider.
 *   items     -- the UI transcript (Item[]); restored verbatim on --continue
 *                so the terminal view is faithful, not reconstructed.
 *   turns     -- one TurnMeta per completed assistant response: model id,
 *                token counts, and wall-clock timestamp. These are the raw
 *                signals the future cost engine and router will learn from.
 *
 * Why usage is always captured: the router needs real per-model token data to
 * score routing candidates accurately. Capturing it unconditionally (even when
 * the user never asks for a cost report) means the data is always there when
 * the router arrives, with no opt-in gap in history. It also lets the live
 * cost indicator in the status bar work without a separate code path.
 *
 * Persistence is best-effort: every write is wrapped in try/catch so a full
 * disk or permission error never crashes the app. Reads that fail return null
 * or an empty collection.
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ModelMessage } from "ai";
import type { Item } from "./ui/types.ts";

// GEARBOX_HOME overrides the data dir (defaults to ~/.gearbox). Useful in
// tests (set to a temp dir) and for users who want state on a different disk.
const root = () => join(process.env.GEARBOX_HOME || join(homedir(), ".gearbox"), "sessions");

/**
 * Returns the slug that names this project's session directory.
 * Derived from process.cwd(): non-alphanumeric runs become hyphens,
 * leading/trailing hyphens are stripped. Falls back to "root" for the
 * filesystem root or any other edge case that produces an empty string.
 */
const slug = (cwd = process.cwd()) =>
  cwd.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root";

/** Absolute path to the session directory for the given project (defaults to
 *  the current one). Callers with a FIXED workspace (conductor tabs persisting
 *  in the background while another tab owns process.cwd()) pass theirs. */
const dir = (cwd?: string) => join(root(), slug(cwd));

/**
 * Per-turn metadata captured after every completed assistant response.
 *
 * Storing one record per turn (rather than per session) lets the router and
 * cost engine see how latency and spend vary across calls within a session,
 * not just totals.
 */
export interface TurnMeta {
  /** Model id that ran this turn. Stored per-turn because routing can vary it mid-session. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Prompt-cache read tokens (the cache hit) when the provider exposes them. */
  cachedInputTokens?: number;
  /**
   * Prompt-cache write tokens (Anthropic-specific).
   * Billed at approximately 125% of the normal input rate for a 5-minute TTL.
   */
  cacheCreationInputTokens?: number;
  /** Unix timestamp (ms) when the turn completed. */
  at: number;
  /** Wire-reported model id that actually served the turn, when the backend exposed one. */
  servedModel?: string;
  /** Retrieval feedback for this turn: which injected files were actually touched by tools. */
  retrieval?: RetrievalUseMeta;
}

export interface RetrievalUseMeta {
  injected: string[];
  used: string[];
  unused: string[];
}

export interface CompactionArchive {
  id: string;
  at: number;
  /** Optional user-supplied focus for this compaction pass. */
  instruction?: string;
  /** 1-based inclusive range of original turns summarized/elided by this pass. */
  turns: { start: number; end: number };
  /** Original provider-neutral messages removed from the active model history. */
  messages: ModelMessage[];
  /** Summary text inserted into the compacted active history, when model-backed. */
  summary?: string;
  /** Structured summary, when the summarizer produced valid JSON. */
  structured?: CompactionSummary;
  /** Deterministic verification of mandatory anchors preserved by the summary. */
  verification?: CompactionVerification;
}

export interface CompactionSummary {
  goals: string[];
  decisions: string[];
  files: { path: string; change: string }[];
  commands: { command: string; outcome: string }[];
  facts: string[];
  openThreads: string[];
  topics: { title: string; notes: string[]; files?: string[] }[];
}

export interface CompactionVerification {
  ok: boolean;
  missingFiles: string[];
  missingCommands: string[];
  missingFailures: string[];
  missingConstraints: string[];
  patch: string[];
}

/**
 * A complete persisted conversation.
 *
 * The three parallel arrays (messages, items, turns) each serve a different
 * consumer: messages feeds the model, items restores the UI, turns feeds the
 * cost/routing layer. They are kept separate so each can evolve independently.
 */
export interface Session {
  id: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  /** First user prompt, used as the display title in session listings. */
  title: string;
  /** Provider-neutral model context window sent on every API call. */
  messages: ModelMessage[];
  /** Full UI transcript, restored verbatim when resuming a session. */
  items: Item[];
  /** One entry per completed turn, carrying model id and token usage. */
  turns: TurnMeta[];
  /** Pinned sessions float to the top of /resume and never age out visually. */
  pinned?: boolean;
  /** Original turns removed by /compact, retained so summaries carry reversible pointers. */
  compactions?: CompactionArchive[];
}

/** Creates the session directory if it does not already exist. */
const ensure = (cwd?: string) => mkdirSync(dir(cwd), { recursive: true });

/**
 * Generates a new session id.
 * Format: "s" + the current timestamp encoded in base-36, e.g. "slr4kj2a".
 * Monotonically increasing within a single process; compact and filesystem-safe.
 */
export function newSessionId(): string {
  return `s${Date.now().toString(36)}`;
}

/**
 * Persists a session to disk as `<dir>/<id>.json`.
 * Failures are silently swallowed so a disk error never crashes the app.
 */
export function saveSession(s: Session, cwd?: string): void {
  try {
    ensure(cwd);
    // Temp-write + rename so a crash mid-write can't tear the session file.
    const path = join(dir(cwd), `${s.id}.json`);
    writeFileSync(`${path}.tmp`, JSON.stringify(s));
    renameSync(`${path}.tmp`, path);
  } catch {
    /* persistence is best-effort; never crash the app over it */
  }
}

/** Delete a saved session's file. Best-effort; true on success. */
export function deleteSession(id: string): boolean {
  try {
    unlinkSync(join(dir(), `${id}.json`));
    return true;
  } catch {
    return false;
  }
}

/** Patch a saved session on disk (rename, pin) without loading it into the
 *  live conversation. Best-effort; returns the updated record or null. */
export function updateSessionMeta(id: string, patch: Partial<Pick<Session, "title" | "pinned">>): Session | null {
  const s = loadSession(id);
  if (!s) return null;
  const next = { ...s, ...patch };
  saveSession(next);
  return next;
}

/**
 * Loads a session by id from the current project's session directory.
 * Returns null when the file is missing or cannot be parsed.
 */
export function loadSession(id: string, cwd?: string): Session | null {
  try {
    return JSON.parse(readFileSync(join(dir(cwd), `${id}.json`), "utf8")) as Session;
  } catch {
    return null;
  }
}

/** Returns all valid sessions for the current project, sorted newest first. */
export function listSessions(): Session[] {
  try {
    return readdirSync(dir())
      .filter((f) => f.endsWith(".json") && f !== "history.json")
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(dir(), f), "utf8")) as Session;
        } catch {
          return null;
        }
      })
      .filter((s): s is Session => s !== null && Array.isArray(s.items))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

/** Returns the most recently updated session for this project, or null. */
export function latestSession(): Session | null {
  return listSessions()[0] ?? null;
}

// ── prompt history (cross-session, per project) ──────────────────────────────
//
// history.json lives alongside the session files in the project's slug dir.
// It is a plain JSON array of prompt strings, capped at 500 entries, used by
// the readline-style up-arrow recall in the input box. It is NOT a session
// file (hence the explicit filter in listSessions).

const histFile = () => join(dir(), "history.json");

/** Loads the prompt history for the current project. Returns [] on any error. */
export function loadHistory(): string[] {
  try {
    const h = JSON.parse(readFileSync(histFile(), "utf8"));
    return Array.isArray(h) ? h : [];
  } catch {
    return [];
  }
}

/**
 * Appends a prompt to the per-project history file.
 *
 * Deduplicates consecutive identical prompts. Trims the array to 500 entries
 * by dropping the oldest. Failures are silently swallowed (best-effort).
 */
export function appendHistory(prompt: string): void {
  const p = prompt.trim();
  if (!p) return;
  try {
    ensure();
    const h = loadHistory();
    if (h[h.length - 1] === p) return;
    h.push(p);
    while (h.length > 500) h.shift();
    // Temp-write + rename so a crash mid-write can't tear history.json.
    writeFileSync(`${histFile()}.tmp`, JSON.stringify(h));
    renameSync(`${histFile()}.tmp`, histFile());
  } catch {
    /* best-effort */
  }
}
