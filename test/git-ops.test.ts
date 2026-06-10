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

test("restoring __pre-restore__ itself works (the advertised undo of a restore)", () => {
  writeFileSync(join(repo, "v1.txt"), "version one\n");
  checkpointSave("before", repo);
  writeFileSync(join(repo, "v1.txt"), "version two\n");
  // First restore: back to "before" — v1 content; current state saved as __pre-restore__.
  expect(checkpointRestore("before", repo).ok).toBe(true);
  expect(readFileSync(join(repo, "v1.txt"), "utf8")).toBe("version one\n");
  // Change of heart: restore __pre-restore__ — must bring BACK version two
  // (this used to overwrite the ref with the current tree and silently no-op).
  expect(checkpointRestore("__pre-restore__", repo).ok).toBe(true);
  expect(readFileSync(join(repo, "v1.txt"), "utf8")).toBe("version two\n");
});

test("checkpoints work inside a linked worktree (where .git is a file)", () => {
  const dir = join(repo, "..", `gearbox-wt-cp-${Date.now()}`);
  expect(worktreeAdd(dir, "cp-branch", repo).ok).toBe(true);
  try {
    writeFileSync(join(dir, "wt.txt"), "in the worktree\n");
    const saved = checkpointSave("wt-check", dir);
    expect(saved.ok).toBe(true);
    writeFileSync(join(dir, "wt.txt"), "mutated\n");
    expect(checkpointRestore("wt-check", dir).ok).toBe(true);
    expect(readFileSync(join(dir, "wt.txt"), "utf8")).toBe("in the worktree\n");
  } finally {
    worktreeRemove(dir, repo);
  }
});

// ── turn checkpoints + diff-view data ─────────────────────────────────────────

test("turnCheckpointSave + pruneTurnCheckpoints keep the newest, spare user checkpoints", async () => {
  const { turnCheckpointSave, pruneTurnCheckpoints, turnCheckpointName } = await import("../src/git/ops.ts");
  checkpointSave("mine", repo);
  for (const n of [1, 2, 3, 4]) {
    writeFileSync(join(repo, "a.txt"), `turn ${n}\n`);
    expect(turnCheckpointSave(n, repo).ok).toBe(true);
  }
  pruneTurnCheckpoints(2, repo);
  const names = checkpointList(repo).map((c) => c.name);
  expect(names).toContain("mine");
  expect(names).toContain(turnCheckpointName(3));
  expect(names).toContain(turnCheckpointName(4));
  expect(names).not.toContain(turnCheckpointName(1));
  expect(names).not.toContain(turnCheckpointName(2));
});

test("a turn checkpoint restores shell-style deletes and renames (the /undo gap)", async () => {
  const { turnCheckpointSave, checkpointRestore: restore, turnCheckpointName } = await import("../src/git/ops.ts");
  writeFileSync(join(repo, "keep.txt"), "keep\n");
  stageAll(repo); commit("seed", repo);
  expect(turnCheckpointSave(7, repo).ok).toBe(true);
  // Simulate a shell turn: delete one file, "rename" another, add a third.
  rmSync(join(repo, "keep.txt"));
  writeFileSync(join(repo, "renamed.txt"), "hello\n");
  rmSync(join(repo, "a.txt"));
  writeFileSync(join(repo, "junk.txt"), "junk\n");
  expect(restore(turnCheckpointName(7), repo).ok).toBe(true);
  expect(readFileSync(join(repo, "keep.txt"), "utf8")).toBe("keep\n");
  expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("hello\n");
  expect(existsSync(join(repo, "renamed.txt"))).toBe(false);
  expect(existsSync(join(repo, "junk.txt"))).toBe(false);
});

test("diffFilesSince reports modified / added / deleted with counts vs a checkpoint", async () => {
  const { diffFilesSince, turnCheckpointSave } = await import("../src/git/ops.ts");
  writeFileSync(join(repo, "gone.txt"), "bye\n");
  stageAll(repo); commit("seed2", repo);
  turnCheckpointSave(9, repo);
  const sha = checkpointList(repo).find((c) => c.name === "__turn-9__")!.sha;
  writeFileSync(join(repo, "a.txt"), "hello\nworld\n"); // modified +1
  writeFileSync(join(repo, "fresh.txt"), "one\ntwo\n"); // untracked new
  rmSync(join(repo, "gone.txt")); // deleted
  const files = diffFilesSince(sha, repo);
  const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
  expect(byPath["a.txt"]!.status).toBe("modified");
  expect(byPath["a.txt"]!.additions).toBe(1);
  expect(byPath["fresh.txt"]!.status).toBe("added");
  expect(byPath["fresh.txt"]!.additions).toBe(2);
  expect(byPath["gone.txt"]!.status).toBe("deleted");
  expect(byPath["gone.txt"]!.deletions).toBe(1);
});

test("diffFilesSince vs HEAD includes untracked files; fileDiffSince renders both", async () => {
  const { diffFilesSince, fileDiffSince } = await import("../src/git/ops.ts");
  writeFileSync(join(repo, "a.txt"), "hello\nplus\n");
  writeFileSync(join(repo, "newby.txt"), "n1\nn2\nn3\n");
  const files = diffFilesSince(null, repo);
  const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
  expect(byPath["a.txt"]!.status).toBe("modified");
  expect(byPath["newby.txt"]!.status).toBe("added");
  expect(byPath["newby.txt"]!.additions).toBe(3);
  expect(fileDiffSince(null, "a.txt", repo)).toContain("+plus");
  const fresh = fileDiffSince(null, "newby.txt", repo);
  expect(fresh).toContain("+n1");
  expect(fresh).toContain("+n3");
});
