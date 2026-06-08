// Project memory — what makes answers repo-aware from message one.
//
// Two layers:
//   1. Project doc (read-only): GEARBOX.md → CLAUDE.md → AGENTS.md, whichever
//      exists. The committed, human-authored brief for the repo.
//   2. Living facts (read/write): ~/.gearbox/memory/<slug>/facts.md — short,
//      timestamped notes the agent or user accumulates across sessions
//      (written by `#note` / `/memory`). Provenance = the timestamp.
// Both are capped so memory can never blow the context budget.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DOC_CANDIDATES = ["GEARBOX.md", "CLAUDE.md", "AGENTS.md", "CONVENTIONS.md"];
const DOC_CAP = 8_000; // chars
const FACTS_CAP = 6_000; // chars

const home = () => process.env.GEARBOX_HOME || join(homedir(), ".gearbox");
// Same slug scheme as src/session.ts so a project's memory and sessions colocate.
const slug = (cwd: string) =>
  cwd.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root";
const memDir = (cwd: string) => join(home(), "memory", slug(cwd));
const factsFile = (cwd: string) => join(memDir(cwd), "facts.md");

/** The committed project brief (GEARBOX.md/CLAUDE.md/AGENTS.md), capped. Empty if none. */
export function loadProjectDoc(cwd = process.cwd()): { name: string; text: string } | null {
  for (const name of DOC_CANDIDATES) {
    const p = join(cwd, name);
    if (!existsSync(p)) continue;
    try {
      const text = readFileSync(p, "utf8").slice(0, DOC_CAP);
      if (text.trim()) return { name, text };
    } catch {
      /* unreadable → try the next */
    }
  }
  return null;
}

/** The living facts file contents, capped (most recent kept). Empty string if none. */
export function loadFacts(cwd = process.cwd()): string {
  try {
    const text = readFileSync(factsFile(cwd), "utf8");
    return text.length > FACTS_CAP ? text.slice(text.length - FACTS_CAP) : text;
  } catch {
    return "";
  }
}

/** Append a timestamped fact. Best-effort; never throws into the caller. */
export function appendFact(text: string, cwd = process.cwd()): boolean {
  const fact = text.trim();
  if (!fact) return false;
  try {
    mkdirSync(memDir(cwd), { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    writeFileSync(factsFile(cwd), `- [${stamp}] ${fact}\n`, { flag: "a" });
    return true;
  } catch {
    return false;
  }
}

/** Assemble the memory block for the system prompt (doc + facts), or "" if empty. */
export function loadProjectMemory(cwd = process.cwd()): string {
  const doc = loadProjectDoc(cwd);
  const facts = loadFacts(cwd).trim();
  const parts: string[] = [];
  if (doc) parts.push(`Project brief (${doc.name}):\n${doc.text.trim()}`);
  if (facts) parts.push(`Remembered facts:\n${facts}`);
  return parts.join("\n\n");
}
