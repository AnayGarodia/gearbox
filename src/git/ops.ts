// Git operations for the /commit /push /pr /worktree /checkpoint suite.
// Everything goes through spawnSyncProc/spawnProc ARG ARRAYS — model-generated
// text (commit messages, PR titles/bodies) must never ride a shell string, so
// there is no injection surface. Pure-ish (no UI imports); App wires thin.
import { spawnSyncProc, spawnProc, which } from "../proc.ts";
import { existsSync, readFileSync, rmSync, realpathSync } from "node:fs";
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

/** The PR base ("origin/main" etc.): origin's HEAD symref, else a common guess. */
export function defaultBase(cwd = process.cwd()): string | null {
  const r = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
  if (r.ok && r.out) return r.out;
  for (const cand of ["origin/main", "origin/master"]) {
    if (git(["rev-parse", "--verify", cand], cwd).ok) return cand;
  }
  return null;
}

/** What this branch contributes to a PR: commits + diffstat vs the merge-base
 *  with the default base branch. Upstream-relative queries are wrong here —
 *  after a push, @{u}..HEAD is empty even though the PR has plenty to say. */
export function branchContribution(cwd = process.cwd()): { commits: string[]; diffstat: string } | null {
  const base = defaultBase(cwd);
  if (!base) return null;
  const mb = git(["merge-base", base, "HEAD"], cwd);
  if (!mb.ok || !mb.out) return null;
  const log = git(["log", `${mb.out}..HEAD`, "--oneline", "--no-decorate"], cwd);
  const stat = git(["diff", `${mb.out}...HEAD`, "--stat"], cwd);
  return { commits: log.ok && log.out ? log.out.split("\n") : [], diffstat: stat.ok ? stat.out : "" };
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
  // The temp index must live in the REAL git dir: in a linked worktree (the
  // state /worktree use puts you in) `<root>/.git` is a pointer FILE, and git
  // can't create an index under it.
  const gitDir = git(["rev-parse", "--absolute-git-dir"], root);
  if (!gitDir.ok || !gitDir.out) return { ok: false, out: "", err: gitDir.err || "couldn't locate the git dir" };
  const tmpIndex = join(gitDir.out, "gearbox-checkpoint-index");
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
  // Resolve the target to a SHA BEFORE saving the safety net: restoring
  // "__pre-restore__" itself would otherwise overwrite the very ref it is
  // restoring (the save below), silently no-op, and orphan the saved state.
  const target = git(["rev-parse", "--verify", ref], root);
  if (!target.ok || !target.out) return { ok: false, out: "", err: `no checkpoint named "${name}"` };
  const targetSha = target.out;
  // Files present now but absent in the snapshot would survive a bare
  // `checkout <sha> -- .`; diff the trees and delete them explicitly. The
  // delete is a plain fs unlink — an untracked newcomer isn't in the real
  // index, so `git rm` would silently no-op on it.
  const current = checkpointSave("__pre-restore__", root); // safety net + comparable tree
  if (!current.ok) return current;
  // -z + --no-renames: NUL-delimited plain paths (C-quoting and rename pairs
  // would otherwise produce names that don't exist on disk).
  const gone = git(["diff", "--name-only", "--no-renames", "-z", "--diff-filter=A", targetSha, `${CHECKPOINT_PREFIX}__pre-restore__`], root);
  const co = git(["checkout", targetSha, "--", "."], root);
  if (!co.ok) return co;
  if (gone.ok && gone.out) {
    const rootReal = (() => { try { return realpathSync(root); } catch { return root; } })();
    for (const f of gone.out.split("\0").filter(Boolean)) {
      // Containment guard: never delete outside the repo root (a hostile tree
      // could otherwise smuggle an escaping path into the snapshot diff).
      const abs = join(root, f);
      try {
        const parentReal = realpathSync(join(abs, ".."));
        if (parentReal !== rootReal && !parentReal.startsWith(rootReal + "/")) continue;
        rmSync(abs, { force: true });
      } catch { /* best-effort */ }
    }
  }
  git(["reset", "--mixed"], root); // leave changes unstaged, index matching HEAD
  return { ok: true, out: name, err: "" };
}

export function checkpointDelete(name: string, cwd = process.cwd()): GitResult {
  return git(["update-ref", "-d", `${CHECKPOINT_PREFIX}${name}`], cwd);
}

// ── turn checkpoints: the /undo substrate for shell-side mutations ────────────
// undo.ts's per-file snapshots only see write/edit tool changes; a `run_shell`
// rename or delete is invisible to them. A whole-tree checkpoint taken lazily at
// a turn's FIRST mutation makes /undo total: restoring it puts the tree back to
// turn start regardless of how the turn mutated it.

const TURN_CHECKPOINT = /^__turn-\d+__$/;
export const turnCheckpointName = (turnId: number): string => `__turn-${turnId}__`;

export function turnCheckpointSave(turnId: number, cwd = process.cwd()): GitResult {
  return checkpointSave(turnCheckpointName(turnId), cwd);
}

/** Drop all but the newest `keep` turn checkpoints (named __turn-N__; user
 *  checkpoints are never touched). Best-effort. */
export function pruneTurnCheckpoints(keep: number, cwd = process.cwd()): void {
  const turns = checkpointList(cwd)
    .filter((c) => TURN_CHECKPOINT.test(c.name))
    .sort((a, b) => (parseInt(b.name.slice(7), 10) || 0) - (parseInt(a.name.slice(7), 10) || 0));
  for (const c of turns.slice(Math.max(0, keep))) checkpointDelete(c.name, cwd);
}

// ── diff-view data: changed files + per-file diffs vs a baseline ──────────────

export interface DiffFileEntry {
  path: string;
  additions: number;
  deletions: number;
  status: "modified" | "added" | "deleted";
  binary: boolean;
}

/** Changed files in the working tree vs `sha` (a checkpoint baseline), or vs
 *  HEAD when sha is null — `git diff --numstat` for tracked changes plus
 *  untracked files counted as pure additions (a checkpoint tree INCLUDES
 *  formerly-untracked files, so vs a checkpoint they surface via numstat;
 *  vs HEAD they only exist in status). */
export function diffFilesSince(sha: string | null, cwd = process.cwd()): DiffFileEntry[] {
  const root = repoRoot(cwd);
  if (!root) return [];
  const base = sha ?? "HEAD";
  const out = new Map<string, DiffFileEntry>();
  const num = git(["diff", "--numstat", "--no-renames", "-z", base, "--", "."], root);
  if (num.ok && num.out) {
    // -z numstat records: "adds\tdels\tpath\0" (path NUL-terminated, no quoting).
    for (const rec of num.out.split("\0").filter(Boolean)) {
      const m = rec.match(/^(\d+|-)\t(\d+|-)\t([\s\S]+)$/);
      if (!m) continue;
      const binary = m[1] === "-";
      const additions = binary ? 0 : parseInt(m[1]!, 10);
      const deletions = binary ? 0 : parseInt(m[2]!, 10);
      const path = m[3]!;
      // Status from existence: absent in base → added; gone from disk → deleted.
      const inBase = git(["cat-file", "-e", `${base}:${path}`], root).ok;
      const onDisk = existsSync(join(root, path));
      out.set(path, { path, additions, deletions, binary, status: !inBase ? "added" : !onDisk ? "deleted" : "modified" });
    }
  }
  // Untracked files (new since base AND never committed) — vs HEAD they don't
  // appear in numstat at all; vs a checkpoint they do (the checkpoint added
  // them), so this only fills the HEAD-baseline gap and dedupes by path.
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"], root);
  if (untracked.ok && untracked.out) {
    for (const path of untracked.out.split("\0").filter(Boolean)) {
      if (out.has(path)) continue;
      const lines = countFileLines(root, path);
      out.set(path, { path, additions: lines ?? 0, deletions: 0, binary: lines == null, status: "added" });
    }
  }
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Unified diff for ONE file: working tree vs `sha` (or HEAD when null).
 *  Untracked files diff against /dev/null so new content still renders. */
export function fileDiffSince(sha: string | null, path: string, cwd = process.cwd()): string {
  const root = repoRoot(cwd);
  if (!root) return "";
  const base = sha ?? "HEAD";
  const inBase = git(["cat-file", "-e", `${base}:${path}`], root).ok;
  if (!inBase) {
    // New file: --no-index exits 1 when files differ, so trust output over ok.
    const r = git(["diff", "--no-index", "--", "/dev/null", path], root);
    return r.out;
  }
  return git(["diff", "--no-renames", base, "--", path], root).out;
}

const countFileLines = (root: string, path: string): number | null => {
  try {
    const buf = readFileSync(join(root, path));
    if (buf.includes(0)) return null; // binary
    const s = buf.toString("utf8");
    return s ? s.split("\n").length - (s.endsWith("\n") ? 1 : 0) : 0;
  } catch {
    return null;
  }
};

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
