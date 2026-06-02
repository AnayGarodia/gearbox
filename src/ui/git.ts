// Current git branch for the status line. Cached (cheap) — refreshed per process.
// execFileSync with an argument array: no shell, no injection surface (fixed args).
import { execFileSync } from "node:child_process";

let cached: string | null | undefined;

export function gitBranch(): string | null {
  if (cached !== undefined) return cached;
  try {
    const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }).trim();
    cached = out || null;
  } catch {
    cached = null;
  }
  return cached;
}
