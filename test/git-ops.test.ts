// git/ops.ts against a real temp repo — reads, writes, worktrees, checkpoints.
// gh paths are not exercised (no network/auth in tests); compareUrl is pure-ish.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  git, isRepo, repoRoot, currentBranch, status, stagedDiff, stageAll, commit,
  aheadBehind, lastCommits, compareUrl, worktreeAdd, worktreeList, worktreeRemove,
  checkpointSave, checkpointList, checkpointRestore, checkpointDelete,
} from "../src/git/ops.ts";

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "gearbox-git-"));
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "test@gearbox.dev"], repo);
  git(["config", "user.name", "gearbox-test"], repo);
  writeFileSync(join(repo, "a.txt"), "hello\n");
  stageAll(repo);
  commit("initial", repo);
});
afterEach(() => {
  for (const w of worktreeList(repo)) if (!w.current) worktreeRemove(w.dir, repo);
  rmSync(repo, { recursive: true, force: true });
});

test("reads: isRepo, repoRoot, currentBranch, lastCommits", () => {
  expect(isRepo(repo)).toBe(true);
  expect(isRepo(tmpdir())).toBe(false);
  // macOS tmpdir is a /private symlink — compare resolved roots via git itself
  expect(repoRoot(repo)).toBeTruthy();
  expect(currentBranch(repo)).toBe("main");
  expect(lastCommits(5, repo)).toHaveLength(1);
  expect(lastCommits(5, repo)[0]).toContain("initial");
});

test("status parses staged / unstaged / untracked / deleted", () => {
  writeFileSync(join(repo, "a.txt"), "changed\n"); // unstaged modify
  writeFileSync(join(repo, "new.txt"), "new\n"); // untracked
  writeFileSync(join(repo, "staged.txt"), "s\n");
  git(["add", "staged.txt"], repo); // staged add
  const s = status(repo);
  const byPath = Object.fromEntries(s.map((e) => [e.path, e]));
  expect(byPath["a.txt"]!.unstaged).toBe(true);
  expect(byPath["a.txt"]!.staged).toBe(false);
  expect(byPath["new.txt"]!.untracked).toBe(true);
  expect(byPath["staged.txt"]!.staged).toBe(true);
});

test("commit message goes through as an arg — quotes/backticks/$ are literal", () => {
  writeFileSync(join(repo, "b.txt"), "x\n");
  stageAll(repo);
  const msg = 'tricky "quotes" `backticks` $(rm -rf /) ; && |';
  const r = commit(msg, repo);
  expect(r.ok).toBe(true);
  expect(lastCommits(1, repo)[0]).toContain('tricky "quotes"');
  expect(existsSync(join(repo, "a.txt"))).toBe(true); // nothing executed
});

test("stagedDiff shows staged changes only", () => {
  writeFileSync(join(repo, "a.txt"), "staged change\n");
  expect(stagedDiff(repo)).toBe(""); // not staged yet
  git(["add", "a.txt"], repo);
  expect(stagedDiff(repo)).toContain("staged change");
  expect(stagedDiff(repo, { stat: true })).toContain("a.txt");
});

test("aheadBehind is null without an upstream", () => {
  expect(aheadBehind(repo)).toBeNull();
});

test("compareUrl builds a GitHub compare link from ssh and https remotes", () => {
  git(["remote", "add", "origin", "git@github.com:user/proj.git"], repo);
  expect(compareUrl(repo)).toBe("https://github.com/user/proj/compare/main?expand=1");
  git(["remote", "set-url", "origin", "https://github.com/user/proj.git"], repo);
  expect(compareUrl(repo)).toBe("https://github.com/user/proj/compare/main?expand=1");
});

test("worktrees: add on a new branch, list, remove", () => {
  const dir = join(repo, "..", `gearbox-wt-${Date.now()}`);
  const r = worktreeAdd(dir, "feature-x", repo);
  expect(r.ok).toBe(true);
  const list = worktreeList(repo);
  expect(list.length).toBe(2);
  const wt = list.find((w) => !w.current)!;
  expect(wt.branch).toBe("feature-x");
  expect(worktreeRemove(wt.dir, repo).ok).toBe(true);
  expect(worktreeList(repo).length).toBe(1);
});

test("checkpoint: save captures untracked files; restore brings them back and removes new ones", () => {
  writeFileSync(join(repo, "untracked.txt"), "precious\n"); // NOT git-added
  expect(checkpointSave("before", repo).ok).toBe(true);
  expect(checkpointList(repo).map((c) => c.name)).toContain("before");

  // Mutate the world: change a tracked file, delete the untracked one, add a new one.
  writeFileSync(join(repo, "a.txt"), "clobbered\n");
  rmSync(join(repo, "untracked.txt"));
  writeFileSync(join(repo, "appeared.txt"), "new file\n");

  expect(checkpointRestore("before", repo).ok).toBe(true);
  expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("hello\n");
  expect(readFileSync(join(repo, "untracked.txt"), "utf8")).toBe("precious\n"); // stash would have lost this
  expect(existsSync(join(repo, "appeared.txt"))).toBe(false); // absent in the snapshot → removed

  // The user's staging area is left clean (no half-staged surprise).
  expect(stagedDiff(repo)).toBe("");
});

test("checkpoint restore on a missing name fails cleanly; delete removes the ref", () => {
  expect(checkpointRestore("nope", repo).ok).toBe(false);
  checkpointSave("temp", repo);
  expect(checkpointDelete("temp", repo).ok).toBe(true);
  expect(checkpointList(repo).map((c) => c.name)).not.toContain("temp");
});

test("checkpoint names are sanitized for refs", () => {
  writeFileSync(join(repo, "c.txt"), "x\n");
  const r = checkpointSave("my checkpoint / with spaces!", repo);
  expect(r.ok).toBe(true);
  expect(r.out).toBe("my-checkpoint-with-spaces");
});
