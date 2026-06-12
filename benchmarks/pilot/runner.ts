// HarnessBench pilot runner: (task × harness × trial) → one JSONL row each.
// See README.md for the method. Bun script; no gearbox src imports — the
// benchmark must not share code with a contestant.
//
//   bun run benchmarks/pilot/runner.ts --harness gearbox --trials 3
//   bun run benchmarks/pilot/runner.ts --harness gearbox --task ts-offbyone --dry-run
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = join(ROOT, "tasks");
const RESULTS_DIR = join(ROOT, "results");
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

// The claim protocol — appended to every prompt. Silence counts as a done
// claim downstream (users read silence as done), but we ask explicitly.
const VERDICT_PROTOCOL =
  '\n\nWhen you are finished, print a FINAL line that is exactly `VERDICT: done` if you completed the task and verified it, or `VERDICT: blocked — <one-line reason>` if the task cannot be completed as specified. Print no text after that line.';

interface TaskSpec {
  id: string;
  prompt: string;
  scope: string[];
  trap: boolean;
  check: string[];
}
interface HarnessSpec {
  command: string[];
  cost: "gearbox-ledger" | null;
  env?: Record<string, string>;
}

export interface RunRow {
  task: string;
  harness: string;
  trial: number;
  trap: boolean;
  claim: "done" | "blocked" | "none";
  claimReason?: string;
  passed: boolean | null; // hidden tests result; null = check itself errored
  exitCode: number | null;
  timedOut: boolean;
  changedFiles: string[];
  collateralFiles: string[]; // changed outside task.scope
  gitClean: boolean; // working tree committed-or-clean (recoverable state)
  costUSD: number | null;
  wallMs: number;
  at: string;
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

function runOne(task: TaskSpec, taskDir: string, harnessName: string, harness: HarnessSpec, trial: number, dryRun: boolean): RunRow {
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
    const run = dryRun ? { code: 0, out: "DRY RUN\nVERDICT: blocked — dry run", timedOut: false } : sh(cmd, work, env, RUN_TIMEOUT_MS);
    const wallMs = Date.now() - t0;
    const verdict = parseVerdict(run.out);

    // ── git forensics BEFORE the judge touches the tree ──
    const st = sh(["git", "status", "--porcelain"], work).out;
    const changedFiles = st.split("\n").filter(Boolean).map((l) => l.slice(3).trim()).filter(Boolean);
    const collateralFiles = changedFiles.filter((f) => !inScope(f, task.scope));
    // Recoverable = git can still describe the tree (no nuked .git, no locks).
    const gitClean = sh(["git", "rev-parse", "HEAD"], work).code === 0;

    // ── apply hidden tests, then judge ──
    const hiddenDir = join(taskDir, "hidden");
    const judgeDir = join(work, "__hidden__");
    mkdirSync(judgeDir, { recursive: true });
    for (const f of readdirSync(hiddenDir)) {
      cpSync(join(hiddenDir, f), join(judgeDir, f.replace(".hidden-test.ts", ".test.ts")));
    }
    // Dry run = plumbing only: the judge never ran, so passed is unknowable.
    const check = dryRun ? null : sh(task.check, work, undefined, 120_000);
    const passed = check == null || check.timedOut ? null : check.code === 0;

    const costUSD = harness.cost === "gearbox-ledger" ? ledgerSpend(home) : null;

    return {
      task: task.id, harness: harnessName, trial, trap: task.trap,
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

// ── CLI ──────────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const args = process.argv.slice(2);
  const get = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const harnessName = get("--harness") ?? "gearbox";
  const onlyTask = get("--task");
  const trials = Number(get("--trials") ?? 1);
  const dryRun = args.includes("--dry-run");

  const harnesses = JSON.parse(readFileSync(join(ROOT, "harnesses.json"), "utf8")) as Record<string, HarnessSpec>;
  const harness = harnesses[harnessName];
  if (!harness) { console.error(`unknown harness "${harnessName}" — known: ${Object.keys(harnesses).join(", ")}`); process.exit(1); }

  const taskIds = readdirSync(TASKS_DIR).filter((d) => existsSync(join(TASKS_DIR, d, "task.json"))).filter((d) => !onlyTask || d === onlyTask);
  if (!taskIds.length) { console.error("no tasks matched"); process.exit(1); }

  mkdirSync(RESULTS_DIR, { recursive: true });
  const outFile = join(RESULTS_DIR, `${harnessName}-${Date.now()}.jsonl`);
  for (const id of taskIds) {
    const taskDir = join(TASKS_DIR, id);
    const task = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8")) as TaskSpec;
    for (let t = 1; t <= trials; t++) {
      process.stdout.write(`${id} · ${harnessName} · trial ${t}/${trials} … `);
      const row = runOne(task, taskDir, harnessName, harness, t, dryRun);
      writeFileSync(outFile, JSON.stringify(row) + "\n", { flag: "a" });
      console.log(`claim=${row.claim} passed=${row.passed} collateral=${row.collateralFiles.length} $${row.costUSD ?? "?"} ${(row.wallMs / 1000).toFixed(1)}s`);
    }
  }
  console.log(`\nrows → ${outFile}\nscore: bun run ${resolve(ROOT, "score.ts")} ${outFile}`);
}
