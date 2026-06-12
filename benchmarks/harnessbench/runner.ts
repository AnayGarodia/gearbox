// HarnessBench runner library: (task × harness × trial) → RunRow, plus the
// submission envelope (metadata + rows + on-disk artifacts) that makes a run
// comparable and auditable later. The CLI lives in bench.ts.
//
// Deliberately imports nothing from gearbox src — a benchmark must not share
// code with a contestant.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

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
}

export interface HarnessSpec {
  command: string[];
  cost: "gearbox-ledger" | null;
  env?: Record<string, string>;
  /** How to capture the harness version for the submission metadata. */
  version?: string[];
}

export interface RunRow {
  task: string;
  category?: string;
  harness: string;
  trial: number;
  trap: boolean;
  claim: "done" | "blocked" | "none";
  claimReason?: string;
  passed: boolean | null; // hidden-test result; null = judge didn't run / timed out
  exitCode: number | null;
  timedOut: boolean;
  changedFiles: string[];
  collateralFiles: string[]; // changed outside task.scope
  gitClean: boolean; // tree still describable by git (recoverable)
  costUSD: number | null;
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
}

export interface Submission {
  meta: SubmissionMeta;
  rows: RunRow[];
}

function sh(cmd: string[], cwd: string, env?: Record<string, string>, timeoutMs?: number) {
  const r = spawnSync(cmd[0]!, cmd.slice(1), {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, timedOut: r.signal === "SIGTERM" };
}

export function parseVerdict(output: string): { claim: "done" | "blocked" | "none"; reason?: string } {
  const lines = output.trim().split("\n").reverse();
  for (const l of lines) {
    const m = /VERDICT:\s*(done|blocked)\s*(?:[—-]\s*(.*))?\s*$/i.exec(l.trim());
    if (m) return { claim: m[1]!.toLowerCase() as "done" | "blocked", reason: m[2]?.trim() };
  }
  return { claim: "none" };
}

/** Glob-lite matcher for scope entries: exact path or dir/** prefix or *.ext. */
export function inScope(file: string, scope: string[]): boolean {
  return scope.some((g) => {
    if (g === file) return true;
    if (g.endsWith("/**")) return file.startsWith(g.slice(0, -2));
    if (g.startsWith("*.")) return file.endsWith(g.slice(1));
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
    const r = sh(spec.version, ROOT, undefined, 15_000);
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

export interface RunOpts {
  dryRun?: boolean;
  /** Where to write per-run artifacts (transcript, diff). Absent = skip. */
  artifactsDir?: string;
  timeoutMs?: number;
}

export function runOne(task: TaskSpec, taskDir: string, harnessName: string, harness: HarnessSpec, trial: number, opts: RunOpts = {}): RunRow {
  const work = mkdtempSync(join(tmpdir(), `hbench-${task.id}-`));
  const home = mkdtempSync(join(tmpdir(), `hbench-home-`)); // isolated per run: no priors/spend leakage
  try {
    cpSync(join(taskDir, "repo"), work, { recursive: true });
    sh(["git", "init", "-qb", "main"], work);
    sh(["git", "-c", "user.email=bench@bench", "-c", "user.name=bench", "add", "-A"], work);
    sh(["git", "-c", "user.email=bench@bench", "-c", "user.name=bench", "commit", "-qm", "fixture"], work);

    const prompt = readFileSync(join(taskDir, task.prompt), "utf8").trim() + VERDICT_PROTOCOL;
    const subst = (s: string) => s.replaceAll("{prompt}", prompt).replaceAll("{home}", home);
    const cmd = harness.command.map(subst);
    const env = Object.fromEntries(Object.entries(harness.env ?? {}).map(([k, v]) => [k, subst(v)]));

    const t0 = Date.now();
    const run = opts.dryRun ? { code: 0, out: "DRY RUN\nVERDICT: blocked — dry run", timedOut: false } : sh(cmd, work, env, opts.timeoutMs ?? RUN_TIMEOUT_MS);
    const wallMs = Date.now() - t0;
    const verdict = parseVerdict(run.out);

    // ── git forensics BEFORE the judge touches the tree ──
    const st = sh(["git", "status", "--porcelain"], work).out;
    const changedFiles = st.split("\n").filter(Boolean).map((l) => l.slice(3).trim()).filter(Boolean);
    const collateralFiles = changedFiles.filter((f) => !inScope(f, task.scope));
    const gitClean = sh(["git", "rev-parse", "HEAD"], work).code === 0;
    const diff = sh(["git", "diff"], work).out;

    // ── artifacts: the audit trail a leaderboard submission rides on ──
    if (opts.artifactsDir) {
      mkdirSync(opts.artifactsDir, { recursive: true });
      writeFileSync(join(opts.artifactsDir, `${task.id}-t${trial}.out.txt`), run.out);
      writeFileSync(join(opts.artifactsDir, `${task.id}-t${trial}.diff.patch`), diff);
    }

    // ── apply hidden tests, then judge ──
    const hiddenDir = join(taskDir, "hidden");
    const judgeDir = join(work, "__hidden__");
    mkdirSync(judgeDir, { recursive: true });
    for (const f of readdirSync(hiddenDir)) {
      cpSync(join(hiddenDir, f), join(judgeDir, f.replace(".hidden-test.ts", ".test.ts")));
    }
    // Dry run = plumbing only: the judge never ran, so passed is unknowable.
    const check = opts.dryRun ? null : sh(task.check, work, undefined, 120_000);
    const passed = check == null || check.timedOut ? null : check.code === 0;

    const costUSD = harness.cost === "gearbox-ledger" ? ledgerSpend(home) : null;

    return {
      task: task.id, category: task.category, harness: harnessName, trial, trap: task.trap,
      claim: verdict.claim, claimReason: verdict.reason,
      passed, exitCode: run.code, timedOut: run.timedOut,
      changedFiles, collateralFiles, gitClean, costUSD, wallMs,
      at: new Date().toISOString(),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}
