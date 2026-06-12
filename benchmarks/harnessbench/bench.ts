// HarnessBench CLI — the one entry point.
//
//   bun run benchmarks/harnessbench/bench.ts doctor
//   bun run benchmarks/harnessbench/bench.ts run --harness gearbox --trials 3 [--model "auto"] [--task id] [--jobs 4] [--resume <runId>] [--dry-run]
//   bun run benchmarks/harnessbench/bench.ts score results/<runId>/submission.json [more…]
//   bun run benchmarks/harnessbench/bench.ts leaderboard [--accept results/<runId>/submission.json]
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  RESULTS_DIR, ROOT, RUNNER_VERSION,
  harnessVersion, loadHarnesses, loadTasks, requiredToolchains, runOne, taskSetHash,
  type RunRow, type Submission,
} from "./runner.ts";
import { SCORING_VERSION, formatReport, parseSubmissionOrRows, scoreHarness } from "./score.ts";
import { renameSync } from "node:fs";

/** Crash-safe submission write: tmp + rename (resume depends on this file). */
function writeSubmission(path: string, sub: Submission): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(sub, null, 2));
  renameSync(tmp, path);
}
import { generateLeaderboard, loadSubmissions } from "./leaderboard.ts";

const LEADERBOARD_DIR = join(ROOT, "leaderboard");

function arg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function cmdDoctor(): number {
  const checks: [string, boolean, string][] = [];
  const has = (bin: string) => spawnSync("which", [bin], { encoding: "utf8" }).status === 0;
  checks.push(["bun", true, process.versions.bun ?? "?"]);
  checks.push(["git", has("git"), ""]);
  const harnesses = loadHarnesses();
  for (const [name, spec] of Object.entries(harnesses)) {
    const present = has(spec.command[0]!);
    checks.push([`harness: ${name}`, present, present ? harnessVersion(spec) ?? "(version unknown)" : `install ${spec.command[0]} to benchmark it`]);
  }
  // Judge toolchains the task set itself needs (bun, python3, …): a missing
  // one means those tasks would all report passed=null and corrupt the run.
  const tasks = loadTasks();
  for (const bin of requiredToolchains(tasks)) {
    checks.push([`judge: ${bin}`, has(bin), has(bin) ? "" : `required by the task set — install before running`]);
  }
  checks.push([`task set`, true, `${tasks.length} tasks · version ${taskSetHash()}`]);
  for (const [name, ok, note] of checks) console.log(`  ${ok ? "✓" : "✗"} ${name.padEnd(20)} ${note}`);
  return checks.every(([, ok]) => ok) ? 0 : 1;
}

/** The (task, trial) cells a resumed run still needs. Exported for tests. */
export function missingCells(
  tasks: { spec: { id: string } }[],
  trials: number,
  existing: Pick<RunRow, "task" | "trial">[],
): { taskId: string; trial: number }[] {
  const have = new Set(existing.map((r) => `${r.task}#${r.trial}`));
  const out: { taskId: string; trial: number }[] = [];
  for (const t of tasks) for (let i = 1; i <= trials; i++) if (!have.has(`${t.spec.id}#${i}`)) out.push({ taskId: t.spec.id, trial: i });
  return out;
}

async function cmdRun(args: string[]): Promise<number> {
  const harnessName = arg(args, "--harness") ?? "gearbox";
  const onlyTask = arg(args, "--task");
  const trialsRaw = arg(args, "--trials");
  const model = arg(args, "--model") ?? null;
  const jobsRaw = arg(args, "--jobs");
  const resume = arg(args, "--resume");
  const dryRun = args.includes("--dry-run");
  const maxCost = Number(arg(args, "--max-cost") ?? 20);

  let trials = trialsRaw == null ? 1 : Number(trialsRaw);
  if (!Number.isInteger(trials) || trials < 1) {
    console.error(`--trials must be a positive integer (got "${trialsRaw}")`);
    return 1;
  }
  const jobs = jobsRaw == null ? 1 : Number(jobsRaw);
  if (!Number.isInteger(jobs) || jobs < 1) {
    console.error(`--jobs must be a positive integer (got "${jobsRaw}")`);
    return 1;
  }
  if (!Number.isFinite(maxCost) || maxCost <= 0) {
    console.error("--max-cost must be a positive number (USD)");
    return 1;
  }

  const harnesses = loadHarnesses();
  const harness = harnesses[harnessName];
  if (!harness) {
    console.error(`unknown harness "${harnessName}" — known: ${Object.keys(harnesses).join(", ")}`);
    return 1;
  }
  // A sharedState harness reads/writes ONE user-level config dir; parallel
  // cells would race it and stop being independent samples.
  if (jobs > 1 && harness.sharedState) {
    console.error(`${harnessName} uses shared user-level state (~ config) — parallel cells are not independent samples; run with --jobs 1`);
    return 1;
  }
  const tasks = loadTasks(onlyTask);
  if (!tasks.length) {
    console.error("no tasks matched");
    return 1;
  }

  // Resume: reload a crashed run's submission and fill only the missing cells.
  let runId = resume ?? `${harnessName}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const runDir = join(RESULTS_DIR, runId);
  const artifactsDir = join(runDir, "artifacts");
  let rows: Submission["rows"] = [];
  let meta: Submission["meta"];
  if (resume) {
    const prevPath = join(runDir, "submission.json");
    if (!existsSync(prevPath)) {
      console.error(`nothing to resume at ${prevPath}`);
      return 1;
    }
    const prev = JSON.parse(readFileSync(prevPath, "utf8")) as Submission;
    if (prev.meta.benchVersion !== taskSetHash()) {
      console.error(`task set changed since ${runId} (${prev.meta.benchVersion} → ${taskSetHash()}) — a resumed run must stay comparable; start fresh`);
      return 1;
    }
    // A resume must CONTINUE the same run: same harness, same trial count,
    // same dry-run mode — otherwise rows with different provenance land in
    // one envelope and the numbers mean nothing.
    if (prev.meta.harness !== harnessName) {
      console.error(`--resume ${runId} was a ${prev.meta.harness} run; rerun with --harness ${prev.meta.harness}`);
      return 1;
    }
    if (trialsRaw != null && trials !== prev.meta.trials) {
      console.error(`--resume continues the original --trials ${prev.meta.trials}; drop the conflicting --trials ${trials}`);
      return 1;
    }
    if (Boolean(prev.meta.dryRun) !== dryRun) {
      console.error(`--resume ${runId} was ${prev.meta.dryRun ? "a dry run" : "a real run"}; the flag must match`);
      return 1;
    }
    trials = prev.meta.trials;
    meta = prev.meta;
    rows = prev.rows;
  } else {
    meta = {
      runId,
      benchVersion: taskSetHash(),
      runnerVersion: RUNNER_VERSION,
      scoringVersion: SCORING_VERSION,
      harness: harnessName,
      harnessVersion: harnessVersion(harness),
      model,
      trials,
      tasks: tasks.length,
      date: new Date().toISOString(),
      ...(dryRun ? { dryRun: true } : {}),
    };
  }
  mkdirSync(artifactsDir, { recursive: true });

  const cells = missingCells(tasks, trials, rows);
  console.log(
    `run ${runId} · bench ${meta.benchVersion} · ${cells.length} cells (${tasks.length} tasks × ${trials} trials${resume ? `, ${rows.length} already done` : ""}) · jobs ${jobs}${dryRun ? " · DRY RUN" : ""}\n`,
  );

  // Bounded-concurrency pool. Persist after EVERY row (single-writer via the
  // pool's shared queue) so a crashed run keeps everything finished so far.
  // The cost cap is a backstop against a looping agent burning real keys:
  // it can only fire for cost-reporting harnesses (others have nothing to sum),
  // checked between cells — a single runaway cell is bounded by the timeout.
  const byId = new Map(tasks.map((t) => [t.spec.id, t]));
  let next = 0;
  let spent = 0;
  let costAborted = false;
  const worker = async () => {
    for (;;) {
      if (costAborted) return;
      const i = next++;
      if (i >= cells.length) return;
      const cell = cells[i]!;
      const t = byId.get(cell.taskId)!;
      const row = await runOne(t.spec, t.dir, harnessName, harness, cell.trial, { dryRun, artifactsDir });
      rows.push(row);
      writeSubmission(join(runDir, "submission.json"), { meta, rows });
      console.log(
        `  ${row.task} · t${row.trial}  claim=${row.claim} passed=${row.passed}${row.infra ? " INFRA" : ""} collateral=${row.collateralFiles.length} $${row.costUSD?.toFixed(3) ?? "?"} ${(row.wallMs / 1000).toFixed(1)}s`,
      );
      spent += row.costUSD ?? 0;
      if (spent > maxCost) {
        costAborted = true;
        console.error(`\n--max-cost ${maxCost} exceeded ($${spent.toFixed(2)} spent) — aborting remaining cells; resume with --resume ${runId} after review`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, cells.length) }, worker));

  console.log(`\n${formatReport(scoreHarness(rows, meta.model))}`);
  console.log(`\nsubmission → ${join(runDir, "submission.json")}   (artifacts: ${artifactsDir})`);
  console.log(`accept to leaderboard: bun run benchmarks/harnessbench/bench.ts leaderboard --accept ${join(runDir, "submission.json")}`);
  return 0;
}

function cmdScore(files: string[]): number {
  if (!files.length) {
    console.error("usage: bench.ts score <submission.json | rows.jsonl> …");
    return 1;
  }
  // Group rows by (harness, model) so mixed files compare cleanly; economics
  // is relative within this comparison set.
  const groups = new Map<string, { model: string | null; rows: ReturnType<typeof parseSubmissionOrRows>["rows"] }>();
  for (const f of files) {
    const { meta, rows } = parseSubmissionOrRows(readFileSync(f, "utf8"));
    for (const r of rows) {
      const key = `${r.harness} ${meta?.model ?? ""}`;
      const g = groups.get(key) ?? { model: meta?.model ?? null, rows: [] };
      g.rows.push(r);
      groups.set(key, g);
    }
  }
  const reports = [...groups.values()].map((g) => scoreHarness(g.rows, g.model));
  const costs = reports.map((r) => r.costPerTrustedDone).filter((c): c is number => c != null && c > 0);
  const best = costs.length ? Math.min(...costs) : null;
  for (const r of reports) console.log(`\n${formatReport(r, best)}`);
  console.log();
  return 0;
}

/**
 * Accept-time validation — SPEC §7 enforced in code, not prose. Exported for
 * tests. Returns the list of violations (empty = acceptable). A submission
 * must be complete (every current task × meta.trials — omitting hard tasks,
 * traps, or trials cannot improve a score), ≥3 trials, not a dry run, version
 * triple matched, and accompanied by its artifacts (transcript + diff per row).
 */
export function validateForAccept(
  sub: Submission,
  current: { benchVersion: string; taskIds: string[]; runnerVersion: number; scoringVersion: number },
  artifactFileNames: string[] | null,
  artifactDir?: string,
): string[] {
  const errs: string[] = [];
  if (!sub?.meta?.runId || !Array.isArray(sub.rows) || !sub.rows.length) return ["not a valid submission envelope"];
  if (sub.meta.dryRun) errs.push("dry-run submissions carry no judgments and cannot be accepted");
  if (sub.meta.benchVersion !== current.benchVersion) errs.push(`benchVersion ${sub.meta.benchVersion} ≠ current ${current.benchVersion} — rerun on the current task set`);
  if (sub.meta.runnerVersion !== current.runnerVersion) errs.push(`runnerVersion ${sub.meta.runnerVersion} ≠ current ${current.runnerVersion}`);
  if ((sub.meta.scoringVersion ?? 0) !== current.scoringVersion) errs.push(`scoringVersion ${sub.meta.scoringVersion ?? "absent"} ≠ current ${current.scoringVersion}`);
  if (sub.meta.trials < 5) errs.push(`leaderboard acceptance needs ≥5 trials per cell for adequate CIs (got ${sub.meta.trials}; hard floor is 3 for private use)`);
  // Completeness: every (task, trial) cell present exactly once.
  const have = new Set(sub.rows.map((r) => `${r.task}#${r.trial}`));
  if (have.size !== sub.rows.length) errs.push("duplicate (task, trial) rows");
  for (const id of current.taskIds) {
    for (let t = 1; t <= sub.meta.trials; t++) {
      if (!have.has(`${id}#${t}`)) errs.push(`missing cell ${id}#${t} — partial submissions are not rankable`);
    }
  }
  const unknown = sub.rows.filter((r) => !current.taskIds.includes(r.task));
  if (unknown.length) errs.push(`rows for unknown tasks: ${[...new Set(unknown.map((r) => r.task))].join(", ")}`);
  // Artifacts: one transcript + one diff per row, content verified against the
  // hashes embedded in the row at run time so copied/swapped artifacts are caught.
  if (artifactFileNames == null) {
    errs.push("artifacts directory not found next to the submission (transcripts + diffs are required for acceptance)");
  } else {
    const haveArt = new Set(artifactFileNames);
    for (const r of sub.rows) {
      const outName = `${r.task}-t${r.trial}.out.txt`;
      const diffName = `${r.task}-t${r.trial}.diff.patch`;
      if (!haveArt.has(outName) || !haveArt.has(diffName)) {
        errs.push(`missing artifacts for ${r.task}#${r.trial}`);
        continue;
      }
      // If the row carries content hashes (produced by runner v2.3+), verify
      // the on-disk files match. This catches artifacts copied from a better run.
      if (r.artifactHashes && artifactDir) {
        const sha = (f: string) => createHash("sha256").update(readFileSync(join(artifactDir, f))).digest("hex");
        if (sha(outName) !== r.artifactHashes.out) errs.push(`artifact content mismatch for ${outName} — file does not match the hash recorded at run time`);
        if (sha(diffName) !== r.artifactHashes.diff) errs.push(`artifact content mismatch for ${diffName} — file does not match the hash recorded at run time`);
      }
    }
  }
  return errs;
}

function cmdLeaderboard(args: string[]): number {
  const accept = arg(args, "--accept");
  mkdirSync(LEADERBOARD_DIR, { recursive: true });
  if (accept) {
    const sub = JSON.parse(readFileSync(accept, "utf8")) as Submission;
    const artDir = join(dirname(accept), "artifacts");
    const artifacts = existsSync(artDir) ? readdirSync(artDir) : null;
    const errs = validateForAccept(
      sub,
      { benchVersion: taskSetHash(), taskIds: loadTasks().map((t) => t.spec.id), runnerVersion: RUNNER_VERSION, scoringVersion: SCORING_VERSION },
      artifacts,
      existsSync(artDir) ? artDir : undefined,
    );
    if (errs.length) {
      for (const e of errs) console.error(`✗ ${e}`);
      return 1;
    }
    const dest = join(LEADERBOARD_DIR, `${sub.meta.runId}.json`);
    if (existsSync(dest)) {
      console.error(`already accepted: ${dest}`);
      return 1;
    }
    cpSync(accept, dest);
    console.log(`accepted → ${dest}`);
  }
  const md = generateLeaderboard(loadSubmissions(LEADERBOARD_DIR), taskSetHash());
  writeFileSync(join(ROOT, "LEADERBOARD.md"), md);
  console.log(`LEADERBOARD.md regenerated (${loadSubmissions(LEADERBOARD_DIR).length} submissions)`);
  return 0;
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "doctor": process.exit(cmdDoctor());
    case "run": process.exit(await cmdRun(rest));
    case "score": process.exit(cmdScore(rest));
    case "leaderboard": process.exit(cmdLeaderboard(rest));
    default:
      console.log("usage: bench.ts <doctor | run | score | leaderboard>  (see README.md)");
      process.exit(cmd ? 1 : 0);
  }
}
