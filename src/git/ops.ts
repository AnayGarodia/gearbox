// Git operations for the /commit /push /pr /worktree /checkpoint suite.
// Everything goes through spawnSyncProc/spawnProc ARG ARRAYS — model-generated
// text (commit messages, PR titles/bodies) must never ride a shell string, so
// there is no injection surface. Pure-ish (no UI imports); App wires thin.
import { spawnSyncProc, spawnProc, which } from "../proc.ts";
import { rmSync } from "node:fs";
import { join } from "node:path";

export interface GitResult {
  ok: boolean;
  out: string;
  err: string;
}

export function git(args: string[], cwd = process.cwd()): GitResult {
  const r = spawnSyncProc(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: (r.exitCode ?? 1) === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

// ── reads ─────────────────────────────────────────────────────────────────────

export function isRepo(cwd = process.cwd()): boolean {
  return git(["rev-parse", "--is-inside-work-tree"], cwd).ok;
}

export function repoRoot(cwd = process.cwd()): string | null {
  const r = git(["rev-parse", "--show-toplevel"], cwd);
  return r.ok && r.out ? r.out : null;
}

export function currentBranch(cwd = process.cwd()): string | null {
  const r = git(["branch", "--show-current"], cwd);
  return r.ok && r.out ? r.out : null; // detached HEAD → null
}

export interface StatusEntry {
  path: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  deleted: boolean;
}

/** Parse `git status --porcelain` (handles renames + quoted paths, like
 *  delegate.ts's changesIn — kept separate so the fan-out path stays frozen).
 *  NOTE: porcelain is column-positional — ` M a.txt` starts with a meaningful
 *  space — so this reads the UNtrimmed stdout, not git()'s trimmed `out`. */
export function status(cwd = process.cwd()): StatusEntry[] {
  const r = spawnSyncProc(["git", "status", "--porcelain"], { cwd, stdout: "pipe", stderr: "pipe" });
  if ((r.exitCode ?? 1) !== 0) return [];
  const out: StatusEntry[] = [];
  for (const line of r.stdout.toString().split("\n")) {
    if (!line) continue;
    const x = line[0] ?? " "; // staged column
    const y = line[1] ?? " "; // unstaged column
    let path = line.slice(3).trim();
    if (path.includes(" -> ")) path = path.split(" -> ")[1]!.trim();
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    if (!path) continue;
    out.push({
      path,
      untracked: x === "?" && y === "?",
      staged: x !== " " && x !== "?",
      unstaged: y !== " " && y !== "?",
      deleted: x === "D" || y === "D",
    });
  }
  return out;
}

export function stagedDiff(cwd = process.cwd(), opts: { stat?: boolean } = {}): string {
  const r = git(["diff", "--cached", ...(opts.stat ? ["--stat"] : [])], cwd);
  return r.ok ? r.out : "";
}

export function unstagedDiff(cwd = process.cwd(), opts: { stat?: boolean } = {}): string {
  const r = git(["diff", ...(opts.stat ? ["--stat"] : [])], cwd);
  return r.ok ? r.out : "";
}

/** Commits ahead/behind the upstream; null when no upstream is configured. */
export function aheadBehind(cwd = process.cwd()): { ahead: number; behind: number } | null {
  const r = git(["rev-list", "--left-right", "--count", "@{u}...HEAD"], cwd);
  if (!r.ok) return null;
  const [behind, ahead] = r.out.split(/\s+/).map((n) => parseInt(n, 10));
  if (Number.isNaN(ahead) || Number.isNaN(behind)) return null;
  return { ahead: ahead!, behind: behind! };
}

export function lastCommits(n: number, cwd = process.cwd()): string[] {
  const r = git(["log", `-${Math.max(1, n)}`, "--oneline", "--no-decorate"], cwd);
  return r.ok && r.out ? r.out.split("\n") : [];
}

/** The commits this branch would contribute to a PR (upstream..HEAD), oneline. */
export function unpushedCommits(cwd = process.cwd()): string[] {
  const r = git(["log", "@{u}..HEAD", "--oneline", "--no-decorate"], cwd);
  return r.ok && r.out ? r.out.split("\n") : [];
}

export function remoteUrl(cwd = process.cwd(), remote = "origin"): string | null {
  const r = git(["remote", "get-url", remote], cwd);
  return r.ok && r.out ? r.out : null;
}

/** origin URL → https compare URL for the branch (the no-gh PR fallback). */
export function compareUrl(cwd = process.cwd()): string | null {
  const url = remoteUrl(cwd);
  const branch = currentBranch(cwd);
  if (!url || !branch) return null;
  const https = url
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/\.git$/, "");
  if (!/^https?:\/\//.test(https)) return null;
  return `${https}/compare/${encodeURIComponent(branch)}?expand=1`;
}

// ── writes ────────────────────────────────────────────────────────────────────

export function stageAll(cwd = process.cwd()): GitResult {
  return git(["add", "-A"], cwd);
}

/** Commit with the message as an ARG (never through a shell). */
export function commit(message: string, cwd = process.cwd()): GitResult {
  return git(["commit", "-m", message], cwd);
}

// ── network (async, streaming) ────────────────────────────────────────────────

export interface StreamResult {
  ok: boolean;
  output: string;
  exitCode: number | null;
}

async function streamProc(cmd: string[], opts: { cwd?: string; onChunk?: (s: string) => void; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<StreamResult> {
  const proc = spawnProc(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe", env: opts.env });
  let output = "";
  // git/gh progress goes to stderr; a network hang is bounded by the timeout
  // (the default 60s shell timeout is too short for a slow push).
  const timeout = setTimeout(() => proc.kill("SIGKILL"), opts.timeoutMs ?? 300_000);
  const dec1 = new TextDecoder();
  const dec2 = new TextDecoder();
  const read = async (s: NodeJS.ReadableStream | null, dec: TextDecoder) => {
    if (!s) return;
    for await (const chunk of s) {
      const text = dec.decode(chunk as Uint8Array, { stream: true });
      output += text;
      if (output.length > 60_000) output = output.slice(-60_000);
      opts.onChunk?.(text);
    }
  };
  try {
    await Promise.all([read(proc.stdout, dec1), read(proc.stderr, dec2), proc.exited]);
  } finally {
    clearTimeout(timeout);
  }
  return { ok: (proc.exitCode ?? 1) === 0, output: output.trim(), exitCode: proc.exitCode };
}

export function push(opts: { setUpstream?: boolean; branch?: string | null; onChunk?: (s: string) => void; cwd?: string } = {}): Promise<StreamResult> {
  const args = ["push"];
  if (opts.setUpstream) args.push("-u", "origin", opts.branch ?? "HEAD");
  return streamProc(["git", ...args], { cwd: opts.cwd, onChunk: opts.onChunk });
}

// ── worktrees ─────────────────────────────────────────────────────────────────

export interface WorktreeInfo {
  dir: string;
  branch: string | null; // null = detached
  head: string;
  current: boolean;
}

export function worktreeList(cwd = process.cwd()): WorktreeInfo[] {
  const r = git(["worktree", "list", "--porcelain"], cwd);
  if (!r.ok || !r.out) return [];
  const here = repoRoot(cwd);
  const out: WorktreeInfo[] = [];
  let cur: Partial<WorktreeInfo> = {};
  for (const line of [...r.out.split("\n"), ""]) {
    if (!line.trim()) {
      if (cur.dir) out.push({ dir: cur.dir, branch: cur.branch ?? null, head: cur.head ?? "", current: cur.dir === here });
      cur = {};
    } else if (line.startsWith("worktree ")) cur.dir = line.slice(9);
    else if (line.startsWith("HEAD ")) cur.head = line.slice(5, 12);
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (line === "detached") cur.branch = null;
  }
  return out;
}

/** Add a worktree at `dir`. With `branch`, creates the branch there (`-b`) if
 *  it doesn't exist, else checks it out; without, detaches at HEAD. */
export function worktreeAdd(dir: string, branch: string | undefined, cwd = process.cwd()): GitResult {
  if (!branch) return git(["worktree", "add", "--detach", dir, "HEAD"], cwd);
  const exists = git(["show-ref", "--verify", `refs/heads/${branch}`], cwd).ok;
  return exists
    ? git(["worktree", "add", dir, branch], cwd)
    : git(["worktree", "add", "-b", branch, dir, "HEAD"], cwd);
}

export function worktreeRemove(dir: string, cwd = process.cwd()): GitResult {
  return git(["worktree", "remove", "--force", dir], cwd);
}

// ── checkpoints (git-ref snapshots — capture untracked files too) ─────────────
// A checkpoint is a commit object created with a TEMP index (so the user's real
// index/staging is untouched) and stored under refs/gearbox/checkpoints/<name>.
// This is addSeededWorktree's baseline-commit trick without the worktree; it
// captures untracked files, which `git stash create` does not. The undo stack
// (undo.ts) can't serve here: it only sees write/edit-tool changes, so a shell
// command's mutations would be lost on restore.

const CHECKPOINT_PREFIX = "refs/gearbox/checkpoints/";

export function checkpointSave(name: string, cwd = process.cwd()): GitResult {
  const root = repoRoot(cwd);
  if (!root) return { ok: false, out: "", err: "not a git repo" };
  const safe = name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "checkpoint";
  const tmpIndex = `${root}/.git/gearbox-checkpoint-index`;
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  const run = (args: string[]) => {
    const r = spawnSyncProc(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe", env });
    return { ok: (r.exitCode ?? 1) === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
  };
  const add = run(["add", "-A"]);
  if (!add.ok) return add;
  const tree = run(["write-tree"]);
  if (!tree.ok) return tree;
  const head = git(["rev-parse", "HEAD"], root);
  const commitArgs = head.ok ? ["commit-tree", tree.out, "-p", head.out, "-m", `gearbox checkpoint: ${safe}`] : ["commit-tree", tree.out, "-m", `gearbox checkpoint: ${safe}`];
  const sha = run(commitArgs);
  if (!sha.ok) return sha;
  const ref = git(["update-ref", `${CHECKPOINT_PREFIX}${safe}`, sha.out], root);
  return ref.ok ? { ok: true, out: safe, err: "" } : ref;
}

export interface CheckpointInfo {
  name: string;
  sha: string;
  at: number; // committer epoch ms
}

export function checkpointList(cwd = process.cwd()): CheckpointInfo[] {
  const r = git(["for-each-ref", "--format=%(refname)%09%(objectname:short)%09%(creatordate:unix)", CHECKPOINT_PREFIX], cwd);
  if (!r.ok || !r.out) return [];
  return r.out.split("\n").filter(Boolean).map((line) => {
    const [ref, sha, unix] = line.split("\t");
    return { name: (ref ?? "").slice(CHECKPOINT_PREFIX.length), sha: sha ?? "", at: (parseInt(unix ?? "0", 10) || 0) * 1000 };
  });
}

/** Restore the working tree to a checkpoint: check out its tree over the
 *  current files AND delete files that didn't exist in the snapshot. The
 *  user's index is reset to match (a restore is a whole-tree operation). */
export function checkpointRestore(name: string, cwd = process.cwd()): GitResult {
  const root = repoRoot(cwd);
  if (!root) return { ok: false, out: "", err: "not a git repo" };
  const ref = `${CHECKPOINT_PREFIX}${name}`;
  if (!git(["rev-parse", "--verify", ref], root).ok) return { ok: false, out: "", err: `no checkpoint named "${name}"` };
  // Files present now but absent in the snapshot would survive a bare
  // `checkout <sha> -- .`; diff the trees and delete them explicitly. The
  // delete is a plain fs unlink — an untracked newcomer isn't in the real
  // index, so `git rm` would silently no-op on it.
  const current = checkpointSave("__pre-restore__", root); // safety net + comparable tree
  if (!current.ok) return current;
  const gone = git(["diff", "--name-only", "--diff-filter=A", ref, `${CHECKPOINT_PREFIX}__pre-restore__`], root);
  const co = git(["checkout", ref, "--", "."], root);
  if (!co.ok) return co;
  if (gone.ok && gone.out) {
    for (const f of gone.out.split("\n").filter(Boolean)) {
      try { rmSync(join(root, f), { force: true }); } catch { /* best-effort */ }
    }
  }
  git(["reset", "--mixed"], root); // leave changes unstaged, index matching HEAD
  return { ok: true, out: name, err: "" };
}

export function checkpointDelete(name: string, cwd = process.cwd()): GitResult {
  return git(["update-ref", "-d", `${CHECKPOINT_PREFIX}${name}`], cwd);
}

// ── gh (GitHub CLI) with graceful fallback ────────────────────────────────────

let ghProbe: boolean | null = null;

export function hasGh(): boolean {
  if (ghProbe !== null) return ghProbe;
  if (!which("gh")) return (ghProbe = false);
  const r = spawnSyncProc(["gh", "auth", "status"], { stdout: "pipe", stderr: "pipe" });
  return (ghProbe = (r.exitCode ?? 1) === 0);
}

/** Test hook. */
export function resetGhProbe(): void {
  ghProbe = null;
}

export function prCreate(opts: { title: string; body: string; base?: string; draft?: boolean; cwd?: string; onChunk?: (s: string) => void }): Promise<StreamResult> {
  const args = ["pr", "create", "--title", opts.title, "--body", opts.body];
  if (opts.base) args.push("--base", opts.base);
  if (opts.draft) args.push("--draft");
  return streamProc(["gh", ...args], { cwd: opts.cwd, onChunk: opts.onChunk });
}

export interface PrInfo {
  number: number;
  title: string;
  author: string;
  branch: string;
  state: string;
  url: string;
}

export function prList(cwd = process.cwd()): PrInfo[] {
  const r = spawnSyncProc(["gh", "pr", "list", "--json", "number,title,author,headRefName,state,url", "--limit", "30"], { cwd, stdout: "pipe", stderr: "pipe" });
  if ((r.exitCode ?? 1) !== 0) return [];
  try {
    const rows = JSON.parse(r.stdout.toString());
    return rows.map((p: any) => ({
      number: p.number, title: p.title ?? "", author: p.author?.login ?? "", branch: p.headRefName ?? "", state: p.state ?? "", url: p.url ?? "",
    }));
  } catch {
    return [];
  }
}

export function prView(n: number | undefined, cwd = process.cwd()): string {
  const args = ["pr", "view", ...(n != null ? [String(n)] : []), "--comments"];
  const r = spawnSyncProc(["gh", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return (r.exitCode ?? 1) === 0 ? r.stdout.toString().trim() : r.stderr.toString().trim();
}

export function prDiff(n: number | undefined, cwd = process.cwd()): string {
  const args = ["pr", "diff", ...(n != null ? [String(n)] : [])];
  const r = spawnSyncProc(["gh", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return (r.exitCode ?? 1) === 0 ? r.stdout.toString().trim() : r.stderr.toString().trim();
}
