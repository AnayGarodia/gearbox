// Worktree sandbox escapes that are deliberately ALLOWED for read-only tools:
//  - pasted screenshots THIS SESSION registered (outside every workspace)
//  - the real git dir of a linked worktree (<root>/.git is a pointer FILE)
// Mutating tools stay jailed to the root. A paste dir from ANOTHER session (not
// registered in this process) stays unreadable — it is not globbed in.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createTools, registerAttachmentDir } from "../src/tools.ts";

const exec = async (t: any, input: any) => (t as any).execute(input, {} as any);

test("read_file allows a REGISTERED gearbox-paste attachment, rejects an unregistered one", async () => {
  const paste = mkdtempSync(join(realpathSync(tmpdir()), "gearbox-paste-"));
  const img = join(paste, "clipboard.png");
  writeFileSync(img, "not-really-a-png");
  // a second paste dir this session never created (stands in for another session)
  const foreign = mkdtempSync(join(realpathSync(tmpdir()), "gearbox-paste-"));
  writeFileSync(join(foreign, "secret.png"), "another-session-screenshot");
  const root = mkdtempSync(join(realpathSync(tmpdir()), "gearbox-ws-"));
  try {
    registerAttachmentDir(paste); // clipboard-image.ts does this on creation
    const tools = createTools(undefined, root);
    const out = await exec(tools.read_file, { path: img });
    expect(String(out)).toContain("not-really-a-png");
    // a foreign session's paste dir is NOT readable (the security fix)
    await expect(exec(tools.read_file, { path: join(foreign, "secret.png") })).rejects.toThrow(/escapes workspace/);
    // and writes into our own paste dir are still refused
    await expect(exec(tools.write_file, { path: join(paste, "x.txt"), content: "no" })).rejects.toThrow(/escapes workspace/);
  } finally {
    rmSync(paste, { recursive: true, force: true });
    rmSync(foreign, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("read_file in a linked worktree can reach the real git dir", async () => {
  const repo = mkdtempSync(join(realpathSync(tmpdir()), "gearbox-repo-"));
  const wt = join(realpathSync(tmpdir()), `gearbox-wt-${Date.now()}`);
  const git = (args: string[], cwd: string) => spawnSync("git", args, { cwd, encoding: "utf8" });
  try {
    git(["init", "-q"], repo);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], repo);
    git(["worktree", "add", "--detach", wt, "HEAD"], repo);
    const tools = createTools(undefined, wt);
    // the worktree's real git dir lives under <repo>/.git/worktrees/<name>
    const gitdir = join(repo, ".git", "worktrees", wt.split("/").pop()!);
    const out = await exec(tools.read_file, { path: join(gitdir, "HEAD") });
    expect(String(out).length).toBeGreaterThan(0);
    // unrelated paths outside both roots remain refused
    await expect(exec(tools.read_file, { path: join(repo, "secret.txt") })).rejects.toThrow(/escapes workspace/);
  } finally {
    git(["worktree", "remove", "--force", wt], repo);
    rmSync(repo, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  }
});

test("extraReadRoots whitelists a caller-supplied directory", async () => {
  const extra = mkdtempSync(join(realpathSync(tmpdir()), "gearbox-extra-"));
  writeFileSync(join(extra, "a.txt"), "hello");
  const root = mkdtempSync(join(realpathSync(tmpdir()), "gearbox-ws-"));
  try {
    const jailed = createTools(undefined, root);
    await expect(exec(jailed.read_file, { path: join(extra, "a.txt") })).rejects.toThrow(/escapes workspace/);
    const opened = createTools(undefined, root, [extra]);
    expect(String(await exec(opened.read_file, { path: join(extra, "a.txt") }))).toContain("hello");
  } finally {
    rmSync(extra, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
