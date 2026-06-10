/**
 * Project Memory: layered repo awareness for the system prompt.
 *
 * Combines two independent sources into a single memory block injected into
 * the stable system prefix by builder.ts:
 *
 *   Layer 1 -- Project doc (read-only, committed to the repo):
 *     Searched in priority order: GEARBOX.md, CLAUDE.md, AGENTS.md,
 *     CONVENTIONS.md. The first match wins. This is the human-authored
 *     brief for the repo: architecture notes, style rules, gotchas. It is
 *     read-only from the agent's perspective; humans edit it directly.
 *     Capped at DOC_CAP chars so a very long doc doesn't dominate the window.
 *
 *   Layer 2 -- Living facts (read/write, per-project, cross-session):
 *     Stored at ~/.gearbox/memory/<slug>/facts.md, where <slug> is a
 *     sanitized version of the absolute project path. The agent (or the user
 *     via #note / /memory commands) appends timestamped one-liners here over
 *     the course of many sessions. Because only the tail is kept (FACTS_CAP),
 *     the most recent facts always survive; old ones age out naturally.
 *
 * Both layers are capped independently before being joined, so together they
 * can never blow the context budget even if both files are very large.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { countTokens } from "../model/tokens.ts";

// Candidates for the project doc, in priority order. The first file that
// exists and is non-empty is used; the rest are ignored.
const DOC_CANDIDATES = ["GEARBOX.md", "CLAUDE.md", "AGENTS.md", "CONVENTIONS.md"];

// Caps for each layer: a cheap character pre-slice, then a TOKEN ceiling.
// The char cap alone under-counted dense docs (a code-heavy CLAUDE.md runs
// far more tokens per char than prose), letting memory quietly eat 2-3k
// tokens of the cached prefix.
const DOC_CAP = 8_000; // chars
const FACTS_CAP = 6_000; // chars
const DOC_TOKEN_CAP = 2_000;
const FACTS_TOKEN_CAP = 1_500;

/** Shrink text (from the given end) until it fits the token ceiling. */
function fitTokens(text: string, maxTokens: number, keep: "head" | "tail"): string {
  let t = text;
  while (t.length > 256 && countTokens(t) > maxTokens) {
    const next = Math.floor(t.length * 0.75);
    t = keep === "head" ? t.slice(0, next) : t.slice(t.length - next);
  }
  return t;
}

// Resolve the Gearbox home directory. Overridable in tests via GEARBOX_HOME.
const home = () => process.env.GEARBOX_HOME || join(homedir(), ".gearbox");

/**
 * Derive a filesystem-safe slug from an absolute project path. Uses the same
 * scheme as src/session.ts so a project's memory and session files colocate
 * under the same slug directory (e.g. ~/.gearbox/memory/home-user-myproject/).
 */
const slug = (cwd: string) =>
  cwd.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root";

// Directory and file path helpers for the per-project facts store.
const memDir = (cwd: string) => join(home(), "memory", slug(cwd));
const factsFile = (cwd: string) => join(memDir(cwd), "facts.md");

/**
 * Load the committed project doc (layer 1).
 *
 * Walks DOC_CANDIDATES in order and returns the first file that exists and
 * contains non-whitespace text, capped at DOC_CAP chars. Returns null when no
 * candidate is found, so callers can omit the block cleanly.
 */
export function loadProjectDoc(cwd = process.cwd()): { name: string; text: string } | null {
  for (const name of DOC_CANDIDATES) {
    const p = join(cwd, name);
    if (!existsSync(p)) continue;
    try {
      const text = fitTokens(readFileSync(p, "utf8").slice(0, DOC_CAP), DOC_TOKEN_CAP, "head");
      if (text.trim()) return { name, text };
    } catch {
      // Unreadable file (permissions, encoding, etc.): try the next candidate.
    }
  }
  return null;
}

/**
 * Load the living facts file (layer 2).
 *
 * Reads ~/.gearbox/memory/<slug>/facts.md and returns its content capped to
 * the MOST RECENT FACTS_CAP chars. Slicing from the end (rather than the
 * beginning) ensures the newest entries always survive when the file grows
 * beyond the cap. Returns an empty string when the file doesn't exist yet.
 */
export function loadFacts(cwd = process.cwd()): string {
  try {
    const text = readFileSync(factsFile(cwd), "utf8");
    // Keep the tail so recent facts take priority over old ones when truncating.
    return fitTokens(text.length > FACTS_CAP ? text.slice(text.length - FACTS_CAP) : text, FACTS_TOKEN_CAP, "tail");
  } catch {
    return "";
  }
}

/**
 * Append a single timestamped fact to the living facts file (layer 2).
 *
 * Creates the memory directory if it doesn't exist yet. The timestamp is
 * ISO-date only (YYYY-MM-DD) for conciseness. Returns true on success and
 * false on any error so callers get a signal without a thrown exception.
 */
// A remembered fact is loaded back into a future turn's system prompt, so a
// multi-line value could smuggle in fake instructions (e.g. a forged
// "# SYSTEM" block). Keep it to a single capped line: collapse all whitespace
// runs (newlines included) to single spaces and cap the length. One short
// sentence is the intended shape anyway.
const MAX_FACT_CHARS = 280;
export function appendFact(text: string, cwd = process.cwd()): boolean {
  const fact = text.replace(/\s+/g, " ").trim().slice(0, MAX_FACT_CHARS);
  if (!fact) return false;
  try {
    mkdirSync(memDir(cwd), { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    // Append mode ("a") so concurrent writes and re-entrancy are safe.
    writeFileSync(factsFile(cwd), `- [${stamp}] ${fact}\n`, { flag: "a" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Assemble the full memory block for injection into the system prompt.
 *
 * Joins layer 1 (project doc) and layer 2 (living facts) with a blank line
 * separator. Returns an empty string when both layers are empty, so builder.ts
 * can skip the "# PROJECT MEMORY" section entirely on a fresh project.
 */
export function loadProjectMemory(cwd = process.cwd()): string {
  const doc = loadProjectDoc(cwd);
  const facts = loadFacts(cwd).trim();
  const parts: string[] = [];
  if (doc) parts.push(`Project brief (${doc.name}):\n${doc.text.trim()}`);
  if (facts) parts.push(`Remembered facts:\n${facts}`);
  return parts.join("\n\n");
}
