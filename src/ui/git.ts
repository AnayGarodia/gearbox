// Current git branch for the status line. Cached on a short TTL — a /commit,
// /worktree use, or out-of-band `git switch` must show up without a restart
// (the old once-per-process cache made the status bar lie after any switch).
// execFileSync with an argument array: no shell, no injection surface (fixed args).
import { execFileSync } from "node:child_process";

const TTL_MS = 5_000;
let cached: string | null | undefined;
let cachedAt = 0;
let cachedCwd = "";

export function gitBranch(): string | null {
  const now = Date.now();
  const cwd = process.cwd();
  if (cached !== undefined && now - cachedAt < TTL_MS && cwd === cachedCwd) return cached;
  try {
    const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }).trim();
    cached = out || null;
  } catch {
    cached = null;
  }
  cachedAt = now;
  cachedCwd = cwd;
  return cached;
}

/** Drop the cache immediately (called after /commit, /worktree use, …). */
export function invalidateGitBranch(): void {
  cached = undefined;
}
