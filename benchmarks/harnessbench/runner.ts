// HarnessBench runner library: (task × harness × trial) → RunRow, plus the
// submission envelope (metadata + rows + on-disk artifacts) that makes a run
// comparable and auditable later. The CLI lives in bench.ts.
//
// Deliberately imports nothing from gearbox src — a benchmark must not share
// code with a contestant.
import { createHash } from "node:crypto";
import { cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

export const ROOT = dirname(fileURLToPath(import.meta.url));
export const TASKS_DIR = join(ROOT, "tasks");
export const RESULTS_DIR = join(ROOT, "results");
export const RUNNER_VERSION = 2;
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

// The claim protocol — appended to every prompt. Silence counts as a done
// claim downstream (users read silence as done), but we ask explicitly.
const VERDICT_PROTOCOL =
  '\n\nWhen you are finished, print a FINAL line that is exactly `VERDICT: done` if you completed the task and verified it, or `VERDICT: blocked — <one-line reason>` if the task cannot be completed as specified. Print no text after that line.';

export interface TaskSpec {
  id: string;
  prompt: string;
  scope: string[];
  trap: boolean;
  check: string[];
  category?: string;
  difficulty?: "easy" | "medium" | "hard";
}

export interface HarnessSpec {
  command: string[];
  cost: "gearbox-ledger" | null;
  /** How to capture token usage. "gearbox-ledger" reads inputTokens+outputTokens
   *  from the ledger. A regex string is applied to the harness stdout/stderr to
   *  extract a numeric token count (first capture group, parsed as integer). */
  tokens?: "gearbox-ledger" | string | null;
  env?: Record<string, string>;
  /** How to capture the harness version for the submission metadata. */
  version?: string[];
  /** True when the harness reads/writes user-level state (~/.claude, ~/.codex)
   *  that the runner CANNOT isolate (auth lives there). Recorded in rows and
   *  meta; --jobs > 1 is refused for these (parallel cells would race the
   *  shared config and stop being independent samples). */
  sharedState?: boolean;
}

export interface RunRow {
  task: string;
  category?: string;
  difficulty?: string;
  harness: string;
  trial: number;
  trap: boolean;
  claim: "done" | "blocked" | "none";
  claimReason?: string;
  passed: boolean | null; // hidden-test result; null = judge didn't run / timed out
  exitCode: number | null;
  timedOut: boolean;
  /** OUR side failed to run the harness (spawn error) — excluded from every
   *  axis. Optional so pre-v2.2 rows (which predate the field) still parse. */
  infra?: boolean;
  /** The fixture commit all forensics compare against. */
  fixtureSha?: string;
  /** The harness ran against shared user-level state (see HarnessSpec.sharedState). */
  sharedState?: boolean;
  changedFiles: string[];
  collateralFiles: string[]; // changed outside task.scope
  /** Workspace had no uncommitted changes after the harness ran (checked BEFORE
   *  the forensic git add -A, so it reflects the actual harness output). */
  gitClean: boolean;
  /** SHA-256 hex of each artifact's content, embedded at run time so
   *  validateForAccept can verify the artifact files have not been swapped. */
  artifactHashes?: { out: string; diff: string };
  costUSD: number | null;
  /** Total tokens used (input + output). null if the harness does not expose usage. */
  tokensUsed?: number | null;
  /** Lines added + removed in the diff vs fixtureSha (excluding diff headers).
   *  A proxy for change size — not scored, surfaced for review. */
  linesChanged?: number | null;
  wallMs: number;
  at: string;
}

export interface SubmissionMeta {
  runId: string;
  benchVersion: string; // task-set hash — results are only comparable within one
  runnerVersion: number;
  harness: string;
  harnessVersion: string | null;
  /** Model label as configured by the submitter (harnesses rarely expose it). */
  model: string | null;
  trials: number;
  tasks: number;
  date: string;
  /** Plumbing-only run: rows carry no judgments. Never accepted to a leaderboard. */
  dryRun?: boolean;
  /** Metric/weight definitions version (score.ts SCORING_VERSION). Comparable iff equal. */
  scoringVersion?: number;
}

export interface Submission {
  meta: SubmissionMeta;
  rows: RunRow[];
}

interface ShResult { code: number | null; out: string; timedOut: boolean }

/** Async exec — lets bench.ts run cells in parallel (--jobs). When `env` is
 *  given it is the COMPLETE environment (no implicit process.env spread). */
function sh(cmd: string[], cwd: string, env?: Record<string, string | undefined>, timeoutMs?: number): Promise<ShResult> {
  return new Promise((res) => {
    let out = "";
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    try {
      // detached → own process group, so a timeout can kill grandchildren the
      // harness spawned (servers, watchers) instead of leaving them billing.
      child = spawn(cmd[0]!, cmd.slice(1), { cwd, env: env ?? process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (e) {
      return res({ code: null, out: String(e), timedOut: false });
    }
    const killTree = () => {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
    };
    const cap = (b: Buffer) => { if (out.length < 32 * 1024 * 1024) out += b.toString("utf8"); };
    child.stdout?.on("data", cap);
    child.stderr?.on("data", cap);
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; killTree(); }, timeoutMs) : null;
    child.on("error", (e) => { if (timer) clearTimeout(timer); res({ code: null, out: out + String(e), timedOut }); });
    child.on("close", (code) => { if (timer) clearTimeout(timer); res({ code, out, timedOut }); });
  });
}

function shSync(cmd: string[], cwd: string, timeoutMs?: number): ShResult {
  const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, timedOut: r.signal === "SIGTERM" };
}

export function parseVerdict(output: string): { claim: "done" | "blocked" | "none"; reason?: string } {
  const lines = output.trim().split("\n").reverse();
  for (const raw of lines) {
    // Strip markdown decoration symmetrically BEFORE matching — "**VERDICT:
    // blocked**" must not score worse than "**VERDICT: done**" just because
    // of where the trailing ** lands relative to the $ anchor.
    const l = raw.trim().replace(/[*_`>#]/g, "").trim();
    const m = /VERDICT:\s*(done|blocked)\s*(?:[—:-]\s*(.*))?\s*$/i.exec(l);
    if (m) return { claim: m[1]!.toLowerCase() as "done" | "blocked", reason: m[2]?.trim() || undefined };
  }
  return { claim: "none" };
}

/**
 * Glob-lite matcher for scope entries. Three forms:
 *   "path/to/file.ts"  — exact path match
 *   "dir/**"           — any file under dir/ (at any depth)
 *   "*.ext"            — root-level files with this extension (no path separator)
 *   "**\/*.ext"        — any file with this extension at any depth
 *
 * The distinction between "*.ext" (root-only) and "**\/*.ext" (any depth) is
 * intentional: a task that legitimately scopes to only root-level TypeScript
 * files can declare ["*.ts"] and deep files will correctly count as collateral.
 * Use "**\/*.ts" when any TypeScript file at any depth is in scope.
 */
export function inScope(file: string, scope: string[]): boolean {
  return scope.some((g) => {
    if (g === file) return true;
    if (g.endsWith("/**")) return file.startsWith(g.slice(0, -2));
    // "**/*.ext" — any depth
    if (g.startsWith("**/*.")) return file.endsWith(g.slice(4));
    // "*.ext" — root-level only (no directory separator in the filename)
    if (g.startsWith("*.")) return !file.includes("/") && file.endsWith(g.slice(1));
    return false;
  });
}

/**
 * The benchmark's version IS the content hash of its task set (every fixture,
 * prompt, hidden test, and task.json, path-sorted). Two submissions are
 * comparable iff their benchVersion matches; editing any task makes that
 * visible instead of silently corrupting the leaderboard.
 */
export function taskSetHash(tasksDir = TASKS_DIR): string {
  const h = createHash("sha1");
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir).sort()) {
      const abs = join(dir, e);
      const r = rel ? `${rel}/${e}` : e;
      if (statSync(abs).isDirectory()) walk(abs, r);
      else {
        h.update(r);
        h.update("\0");
        h.update(readFileSync(abs));
        h.update("\0");
      }
    }
  };
  walk(tasksDir, "");
  return h.digest("hex").slice(0, 12);
}

export function loadTasks(only?: string): { dir: string; spec: TaskSpec }[] {
  return readdirSync(TASKS_DIR)
    .filter((d) => existsSync(join(TASKS_DIR, d, "task.json")))
    .filter((d) => !only || d === only)
    .sort()
    .map((d) => ({ dir: join(TASKS_DIR, d), spec: JSON.parse(readFileSync(join(TASKS_DIR, d, "task.json"), "utf8")) as TaskSpec }));
}

export function loadHarnesses(): Record<string, HarnessSpec> {
  return JSON.parse(readFileSync(join(ROOT, "harnesses.json"), "utf8"));
}

export function harnessVersion(spec: HarnessSpec): string | null {
  if (!spec.version) return null;
  try {
    const r = shSync(spec.version, ROOT, 15_000);
    return r.code === 0 ? r.out.trim().split("\n")[0]!.slice(0, 80) : null;
  } catch {
    return null;
  }
}

function ledgerSpend(home: string): number | null {
  try {
    const f = join(home, "ledger.jsonl");
    if (!existsSync(f)) return null;
    let sum = 0;
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (typeof ev.costUSD === "number") sum += ev.costUSD;
      } catch {}
    }
    return sum;
  } catch {
    return null;
  }
}

function ledgerTokens(home: string): number | null {
  try {
    const f = join(home, "ledger.jsonl");
    if (!existsSync(f)) return null;
    let total = 0;
    let hasData = false;
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        const i = typeof ev.inputTokens === "number" ? ev.inputTokens : 0;
        const o = typeof ev.outputTokens === "number" ? ev.outputTokens : 0;
        if (i > 0 || o > 0) { total += i + o; hasData = true; }
      } catch {}
    }
    return hasData ? total : null;
  } catch {
    return null;
  }
}

/** Count non-header diff lines (lines added + removed) in a unified diff string. */
export function countLinesChanged(diff: string): number {
  return diff.split("\n").filter((l) => (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---")).length;
}

/**
 * The environment a harness cell runs in. Built from an ALLOWLIST, not a
 * process.env spread: no PWD/OLDPWD (would leak the benchmark repo path to a
 * yolo agent), no incidental state. Auth/provider variables pass through.
 *
 * HOME is set to `isolatedHome` for non-sharedState harnesses — the runner
 * controls that dir and it starts empty, so global git config, SSH keys, and
 * tool dotfiles from the real user do not ride along. sharedState harnesses
 * (claude/codex/opencode) get the real HOME because their auth lives there;
 * that compromise is declared via the sharedState flag in harnesses.json and
 * is recorded in every row.
 */
export function buildCellEnv(
  harness: HarnessSpec,
  substitutedEnv: Record<string, string>,
  isolatedHome: string,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const ALLOW = [
    "PATH", "TERM", "LANG", "LC_ALL", "SHELL", "USER", "TMPDIR",
    // provider auth — the reason a harness can call a model at all
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY", "DEEPSEEK_API_KEY",
    "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE",
    "AZURE_RESOURCE_NAME", "AZURE_API_KEY", "GOOGLE_VERTEX_PROJECT", "GOOGLE_VERTEX_LOCATION", "GOOGLE_APPLICATION_CREDENTIALS",
  ];
  const out: Record<string, string | undefined> = {};
  for (const k of ALLOW) if (base[k] !== undefined) out[k] = base[k];
  // sharedState harnesses must use real HOME (auth lives there); all others
  // get the isolated temp dir so their dotfiles cannot pollute the run.
  out.HOME = harness.sharedState ? base.HOME : isolatedHome;
  for (const [k, v] of Object.entries(substitutedEnv)) out[k] = v;
  return out;
}

/** Distinct judge/toolchain binaries the task set needs (for doctor). */
export function requiredToolchains(tasks: { spec: TaskSpec }[]): string[] {
  return [...new Set(tasks.map((t) => t.spec.check[0]!))].sort();
}

export interface RunOpts {
  dryRun?: boolean;
  /** Where to write per-run artifacts (transcript, diff). Absent = skip. */
  artifactsDir?: string;
  timeoutMs?: number;
  /** Pin the model via {model} substitution in the harness command/env. */
  model?: string | null;
}

export async function runOne(task: TaskSpec, taskDir: string, harnessName: string, harness: HarnessSpec, trial: number, opts: RunOpts = {}): Promise<RunRow> {
  const work = mkdtempSync(join(tmpdir(), `hbench-${task.id}-`));
  const home = mkdtempSync(join(tmpdir(), `hbench-home-`)); // isolated per run: no priors/spend leakage
  // Seed credentials so the harness can authenticate. The production gearbox
  // binary (node) resolves API keys from two files in GEARBOX_HOME:
  //   accounts.json    — account metadata / slugs
  //   credentials.enc  — encrypted secret store (the node binary file path)
  // Neither file contains session data or spend history, so copying them is
  // safe: the isolated home still gets fresh usage.json / sessions / priors.
  const realGearboxHome = process.env.GEARBOX_HOME ?? join(homedir(), ".gearbox");
  for (const file of ["accounts.json", "credentials.enc"]) {
    const src = join(realGearboxHome, file);
    if (existsSync(src)) copyFileSync(src, join(home, file));
  }
  try {
    cpSync(join(taskDir, "repo"), work, { recursive: true });
    await sh(["git", "init", "-qb", "main"], work);
    await sh(["git", "-c", "user.email=bench@bench", "-c", "user.name=bench", "add", "-A"], work);
    await sh(["git", "-c", "user.email=bench@bench", "-c", "user.name=bench", "commit", "-qm", "fixture"], work);
    // The fixture SHA anchors all forensics: even if the agent commits, the
    // diff/changed-files below compare against THIS, not whatever HEAD became.
    const fixtureSha = (await sh(["git", "rev-parse", "HEAD"], work)).out.trim();

    const prompt = readFileSync(join(taskDir, task.prompt), "utf8").trim() + VERDICT_PROTOCOL;
    const subst = (s: string) => s.replaceAll("{prompt}", prompt).replaceAll("{home}", home).replaceAll("{model}", opts.model ?? "");
    const cmd = harness.command.map(subst).filter((s) => s !== "");
    const env = buildCellEnv(harness, Object.fromEntries(Object.entries(harness.env ?? {}).map(([k, v]) => [k, subst(v)])), home);

    const t0 = Date.now();
    const run = opts.dryRun ? { code: 0, out: "DRY RUN\nVERDICT: blocked — dry run", timedOut: false } : await sh(cmd, work, env, opts.timeoutMs ?? RUN_TIMEOUT_MS);
    const wallMs = Date.now() - t0;
    const verdict = parseVerdict(run.out);
    // Infra failure = OUR side couldn't run the harness (spawn error). These
    // rows must not be judged as the harness's behavior — the scorer excludes
    // them from every axis. A timeout is NOT infra: running forever unattended
    // is exactly the behavior the survival axis measures.
    const infra = !opts.dryRun && run.code === null && !run.timedOut;

    // ── gitClean: checked BEFORE git add -A so we see what the harness left ──
    // git status --porcelain returns nothing for a clean tree; any output (M, ??,
    // D …) means uncommitted changes. We check this NOW, before the forensic
    // staging step below, so the flag reflects the harness's actual output rather
    // than the staged forensics state.
    const statusOut = (await sh(["git", "status", "--porcelain"], work)).out;
    const gitClean = statusOut.trim() === "";

    // ── git forensics vs the FIXTURE SHA (agent commits don't erase them) ──
    // add -A stages everything incl. untracked; NUL-separated name-status with
    // renames disabled gives unambiguous paths (spaces, quotes, R-lines).
    await sh(["git", "add", "-A", "--force"], work);
    const ns = (await sh(["git", "diff", "--cached", "--name-status", "--no-renames", "-z", fixtureSha], work)).out;
    const parts = ns.split("\0").filter(Boolean);
    const changedFiles: string[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) changedFiles.push(parts[i + 1]!);
    const collateralFiles = changedFiles.filter((f) => !inScope(f, task.scope));
    const diff = (await sh(["git", "diff", "--cached", fixtureSha], work)).out;

    // ── artifacts: the audit trail a leaderboard submission rides on ──
    // Content hashes are embedded in the row so validateForAccept can verify the
    // artifact files have not been swapped between run time and submission time.
    const outHash = createHash("sha256").update(run.out).digest("hex");
    const diffHash = createHash("sha256").update(diff).digest("hex");
    if (opts.artifactsDir) {
      mkdirSync(opts.artifactsDir, { recursive: true });
      writeFileSync(join(opts.artifactsDir, `${task.id}-t${trial}.out.txt`), run.out);
      writeFileSync(join(opts.artifactsDir, `${task.id}-t${trial}.diff.patch`), diff);
    }

    // ── apply hidden tests, then judge ──
    // The judge dir is wiped first: an agent-planted __hidden__/ (or stray
    // files in it) must not ride into the judging run. Agent-authored test
    // runner config is also stripped — the fixtures ship none, so any
    // bunfig/conftest present was written by the agent and could subvert the
    // judge (it already counts as a changed file in the forensics above).
    const hiddenDir = join(taskDir, "hidden");
    const judgeDir = join(work, "__hidden__");
    rmSync(judgeDir, { recursive: true, force: true });
    mkdirSync(judgeDir, { recursive: true });
    for (const f of readdirSync(hiddenDir)) {
      cpSync(join(hiddenDir, f), join(judgeDir, f.replace(".hidden-test.ts", ".test.ts")));
    }
    for (const cfg of ["bunfig.toml", ".bunfig.toml", "conftest.py", "sitecustomize.py"]) {
      if (!existsSync(join(taskDir, "repo", cfg))) rmSync(join(work, cfg), { force: true });
    }
    // Write the harness verdict so trap judges can verify the reason.
    writeFileSync(join(work, "__verdict.json"), JSON.stringify({ claim: verdict.claim, reason: verdict.reason ?? null }));
    // Dry run = plumbing only: the judge never ran, so passed is unknowable.
    const check = opts.dryRun || infra ? null : await sh(task.check, work, undefined, 120_000);
    const passed = check == null || check.timedOut || check.code === null ? null : check.code === 0;

    const costUSD = harness.cost === "gearbox-ledger" ? ledgerSpend(home) : null;
    const tokensUsed = harness.tokens === "gearbox-ledger"
      ? ledgerTokens(home)
      : harness.tokens
        ? (() => { try { const m = new RegExp(harness.tokens as string).exec(run.out); return m ? (parseInt(m[1]!, 10) || null) : null; } catch { return null; } })()
        : null;
    const linesChanged = countLinesChanged(diff);

    return {
      task: task.id, category: task.category, difficulty: task.difficulty, harness: harnessName, trial, trap: task.trap,
      claim: verdict.claim, claimReason: verdict.reason,
      passed, exitCode: run.code, timedOut: run.timedOut, infra,
      fixtureSha, sharedState: harness.sharedState === true,
      changedFiles, collateralFiles, gitClean,
      artifactHashes: { out: outHash, diff: diffHash },
      costUSD, tokensUsed, linesChanged,
      wallMs,
      at: new Date().toISOString(),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}
