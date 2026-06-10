// Project file listing (for @mentions) and mention expansion (read referenced
// files into the model message). IO lives here; the matching logic is in mention.ts.
import { execFileSync } from "node:child_process";
import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const IGNORE = new Set(["node_modules", ".git", "dist", ".next", "build", "coverage"]);
const MAX_FILES = 5000;
const MAX_ATTACH = 20_000;

let cache: string[] | null = null;

/** Drop the cached file list so the next listProjectFiles() re-scans — called
 *  after the agent creates a file, so new files show up in @mentions. */
export function invalidateFileListCache(): void {
  cache = null;
}

export function listProjectFiles(cwd = process.cwd()): string[] {
  if (cache) return cache;
  // git ls-files is fast and automatically respects .gitignore.
  try {
    const out = execFileSync("git", ["ls-files"], { cwd, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
    const files = out.split("\n").map((s) => s.trim()).filter(Boolean);
    if (files.length) return (cache = files.slice(0, MAX_FILES));
  } catch {
    /* not a git repo — fall through */
  }
  // Fallback: bounded recursive walk capped at MAX_FILES.
  const files: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || files.length > MAX_FILES) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.startsWith(".") || IGNORE.has(e)) continue;
      const p = join(dir, e);
      let s;
      try {
        s = statSync(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) walk(p, depth + 1);
      else files.push(relative(cwd, p));
    }
  };
  walk(cwd, 0);
  return (cache = files.slice(0, MAX_FILES));
}

/** Expand @path tokens that point at real files into the model message. */
export function expandMentions(prompt: string, cwd = process.cwd()): { text: string; attached: string[] } {
  const tokens = [...prompt.matchAll(/@([^\s]+)/g)].map((m) => m[1]!);
  const attached: string[] = [];
  let extra = "";
  for (const raw of tokens) {
    // Hand-typed mentions often carry trailing punctuation ("@foo.ts," or "(@foo.ts)").
    // Strip trailing )].,;:!?"'>} progressively so the file still attaches.
    let trimmed = raw;
    const candidates = [raw];
    while (/[)\].,;:!?'"}>]$/.test(trimmed)) { trimmed = trimmed.slice(0, -1); if (trimmed) candidates.push(trimmed); }
    const t = candidates.find((c) => existsSync(resolve(cwd, c)));
    if (!t) continue;
    try {
      const content = readFileSync(resolve(cwd, t), "utf8").slice(0, MAX_ATTACH);
      extra += `\n\n=== ${t} ===\n${content}`;
      attached.push(t);
    } catch {
      /* skip unreadable */
    }
  }
  return { text: extra ? prompt + extra : prompt, attached };
}
