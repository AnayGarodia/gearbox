// Tab worktrees must support the full git suite from their own branch, and
// nesting them under <repo>/.gearbox must never leak into the base tree's
// status/add. Real temp repos; no network (push/PR argv construction is
// covered by ops' arg-array design — remotes aren't exercised here).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, ensureExcluded, worktreeAdd, status, currentBranch } from "../src/git/ops.ts";

function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gbx-wt-")));
  git(["init", "-b", "main"], dir);
  git(["config", "user.email", "t@t"], dir);
  git(["config", "user.name", "t"], dir);
  writeFileSync(join(dir, "a.txt"), "hello\n");
  git(["add", "-A"], dir);
  git(["commit", "-m", "init"], dir);
  return dir;
}

describe("tab worktree git actions", () => {
  test("ensureExcluded hides .gearbox/tabs/ from the base tree; idempotent", () => {
    const repo = makeRepo();
    try {
      expect(ensureExcluded(".gearbox/tabs/", repo)).toBe(true);
      expect(ensureExcluded(".gearbox/tabs/", repo)).toBe(true); // no duplicate line
      const excl = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
      expect(excl.split("\n").filter((l) => l.trim() === ".gearbox/tabs/")).toHaveLength(1);

      // Nest a tab-style worktree, then dirty it — the BASE tree must stay clean.
      const wt = join(repo, ".gearbox", "tabs", "wizard");
      expect(worktreeAdd(wt, "tab/wizard", repo).ok).toBe(true);
      writeFileSync(join(wt, "tab-work.txt"), "wip\n");
      expect(status(repo)).toEqual([]); // nothing untracked leaks into the base

      // Committable project config OUTSIDE tabs/ must stay VISIBLE to git —
      // excluding all of .gearbox/ hid permissions.json/mcp.json (review).
      writeFileSync(join(repo, ".gearbox", "permissions.json"), "{}\n");
      expect(status(repo).some((e) => e.path.startsWith(".gearbox/"))).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("commit on the tab branch from inside the worktree; base branch untouched", () => {
    const repo = makeRepo();
    try {
      ensureExcluded(".gearbox/tabs/", repo);
      const wt = join(repo, ".gearbox", "tabs", "skater");
      expect(worktreeAdd(wt, "tab/skater", repo).ok).toBe(true);
      expect(currentBranch(wt)).toBe("tab/skater");

      writeFileSync(join(wt, "feature.txt"), "new\n");
      expect(git(["add", "-A"], wt).ok).toBe(true);
      expect(git(["commit", "-m", "tab work"], wt).ok).toBe(true);
      // The shared gitdir write worked (this is what the sandbox's
      // gitDirWritePaths must keep writable) and the branch advanced…
      expect(git(["log", "--oneline", "tab/skater"], repo).out).toContain("tab work");
      // …while main did not.
      expect(git(["log", "--oneline", "main"], repo).out).not.toContain("tab work");
      expect(currentBranch(repo)).toBe("main");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
