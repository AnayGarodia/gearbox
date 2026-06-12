// Routing-bench runner. For every (task, policy) pair: build a fresh fixture
// workspace, run `gearbox -p "<prompt>" --verify --json --router <policy>`
// inside it, then inject the HIDDEN judge test (which the agent never saw) and
// record cost / speed / quality. Rows land incrementally in rows.jsonl so an
// aborted run still reports what it measured.
//
//   bun run experiments/routing-bench/run.ts                # everything
//     --policies baseline,thompson  --tasks ts-clamp,…      # filters
//     --cap 30          total USD budget (hard stop)
//     --timeout 300     per-run seconds
//     --mock            no spawns, fabricated rows (plumbing/report dry-run)
//     --out <dir>       results dir (default results/run-<n>)
//
// Cost accounting reads the per-policy LEDGER delta (every dollar including
// the classify hop and cascade aux calls), not just the turn usage — the same
// spend-truth rule as the app. Each policy gets its own GEARBOX_HOME so the
// priors/precedent flywheel accumulates across tasks WITHIN a policy (that
// learning is part of what's being measured) without cross-contamination.
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { TS_TASKS } from "./tasks-ts.ts";
import { PY_TASKS } from "./tasks-py.ts";
import type { BenchTask, BenchRow } from "./types.ts";

const REPO = resolve(import.meta.dir, "../..");
const ALL_TASKS: BenchTask[] = [...TS_TASKS, ...PY_TASKS];
const ALL_POLICIES = [
  "baseline", "expected-cost", "precedent", "thompson", "fix-routing",
  "observables", "selfverify", "draft-review", "combined",
  "fixed-strong", "fixed-cheap", "random",
];

// ── args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const argVal = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const mock = args.includes("--mock");
const capUSD = Number(argVal("cap") ?? 30);
const timeoutMs = Number(argVal("timeout") ?? 300) * 1000;
const policies = (argVal("policies")?.split(",") ?? ALL_POLICIES).map((s) => s.trim()).filter(Boolean);
const taskFilter = argVal("tasks")?.split(",").map((s) => s.trim());
const tasks = taskFilter ? ALL_TASKS.filter((t) => taskFilter.includes(t.id)) : ALL_TASKS;
const outDir = resolve(REPO, argVal("out") ?? join("experiments/routing-bench/results", `run-${nextRunNumber()}`));

function nextRunNumber(): number {
  const dir = resolve(REPO, "experiments/routing-bench/results");
  try {
    const ns = readdirSync(dir).map((d) => Number(d.match(/^run-(\d+)$/)?.[1])).filter((n) => Number.isFinite(n));
    return ns.length ? Math.max(...ns) + 1 : 1;
  } catch {
    return 1;
  }
}

// Seed a per-policy GEARBOX_HOME with the user's METERED accounts only (no
// subscription seats — a ~free seat would make every policy converge on it and
// the cost comparison would measure nothing). Secret refs resolve via the OS
// keychain, which is global, so copying the account records is enough.
function seedHome(home: string): void {
  const src = join(homedir(), ".gearbox", "accounts.json");
  const dst = join(home, "accounts.json");
  if (existsSync(dst) || !existsSync(src)) return;
  try {
    const f = JSON.parse(readFileSync(src, "utf8"));
    const metered = (f.accounts ?? []).filter((a: any) => a.exec !== "cli" && a.enabled !== false);
    const defaults: Record<string, string> = {};
    for (const [prov, id] of Object.entries(f.defaults ?? {})) {
      if (metered.some((a: any) => a.id === id)) defaults[prov] = id as string;
    }
    writeFileSync(dst, JSON.stringify({ ...f, accounts: metered, defaults }, null, 2), { mode: 0o600 });
  } catch {
    /* env keys may still serve */
  }
}

// ── workspace + judge ────────────────────────────────────────────────────────
function git(cwd: string, ...argv: string[]): void {
  spawnSync("git", ["-c", "user.email=bench@gearbox", "-c", "user.name=bench", ...argv], { cwd, encoding: "utf8", timeout: 20_000 });
}

function makeWorkspace(task: BenchTask, policy: string): string {
  const ws = join(outDir, "work", `${task.id}--${policy}`);
  mkdirSync(ws, { recursive: true });
  for (const [rel, content] of Object.entries(task.files)) {
    mkdirSync(dirname(join(ws, rel)), { recursive: true });
    writeFileSync(join(ws, rel), content);
  }
  git(ws, "init", "-q");
  git(ws, "add", "-A");
  git(ws, "commit", "-qm", "fixture");
  return ws;
}

function runJudge(task: BenchTask, ws: string): boolean {
  writeFileSync(join(ws, task.hidden.file), task.hidden.content);
  const r =
    task.hidden.kind === "bun"
      ? spawnSync("bun", ["test", task.hidden.file.replace(/\.test\.ts$/, "")], { cwd: ws, encoding: "utf8", timeout: 120_000 })
      : spawnSync("python3", [task.hidden.file], { cwd: ws, encoding: "utf8", timeout: 120_000 });
  return r.status === 0;
}

// ── cost from the ledger delta ───────────────────────────────────────────────
function ledgerLines(home: string): number {
  try {
    return readFileSync(join(home, "ledger.jsonl"), "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}
function ledgerCostSince(home: string, fromLine: number): number {
  try {
    const lines = readFileSync(join(home, "ledger.jsonl"), "utf8").split("\n").filter(Boolean).slice(fromLine);
    let usd = 0;
    for (const l of lines) {
      try { usd += JSON.parse(l).costUSD ?? 0; } catch { /* torn line */ }
    }
    return usd;
  } catch {
    return 0;
  }
}

// ── one run ──────────────────────────────────────────────────────────────────
function runOne(task: BenchTask, policy: string, home: string): BenchRow {
  const ws = makeWorkspace(task, policy);
  const before = ledgerLines(home);
  const started = Date.now();
  const r = spawnSync("bun", ["run", join(REPO, "src/cli.tsx"), "-p", task.prompt, "--verify", "--json", "--router", policy], {
    cwd: ws,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GEARBOX_HOME: home, GEARBOX_SKIP_ONBOARD: "1", GEARBOX_NO_MOTION: "1" },
  });
  const wallMs = Date.now() - started;
  // The result is the last stdout line that parses as JSON (warnings may precede it).
  let parsed: any = null;
  for (const line of (r.stdout ?? "").split("\n").reverse()) {
    if (!line.trim().startsWith("{")) continue;
    try { parsed = JSON.parse(line); break; } catch { /* keep looking */ }
  }
  const ledgerUSD = ledgerCostSince(home, before);
  const hiddenOk = runJudge(task, ws);
  return {
    task: task.id,
    tier: task.tier,
    visible: task.visible,
    policy,
    hiddenOk,
    agentOk: Boolean(parsed?.ok),
    costUSD: ledgerUSD || parsed?.totals?.costUSD || 0,
    wallMs,
    inputTokens: parsed?.totals?.inputTokens ?? 0,
    outputTokens: parsed?.totals?.outputTokens ?? 0,
    attempts: parsed?.attempts?.length ?? 0,
    models: (parsed?.attempts ?? []).map((a: any) => a.model),
    kind: parsed?.kind,
    verifierTier: parsed?.verifierTier,
    error: parsed ? parsed.error : `spawn: ${(r.stderr ?? "").split("\n").filter(Boolean).slice(-2).join(" / ").slice(0, 300) || `status ${r.status}`}`,
  };
}

// Mock row — validates corpus/runner/report plumbing with zero spend. Clearly
// fabricated (models named mock-*) so it can never be mistaken for data.
function mockOne(task: BenchTask, policy: string): BenchRow {
  const strong = policy === "fixed-strong" || policy === "baseline" || task.tier === "T3";
  return {
    task: task.id, tier: task.tier, visible: task.visible, policy,
    hiddenOk: policy !== "fixed-cheap" || task.tier === "T1",
    agentOk: true,
    costUSD: strong ? 0.08 : 0.02,
    wallMs: 20_000 + task.prompt.length * 10,
    inputTokens: 12_000, outputTokens: 2_000,
    attempts: 1, models: [strong ? "mock-strong" : "mock-cheap"],
    kind: "code", verifierTier: task.visible ? "tests" : "none",
  };
}

// ── main ─────────────────────────────────────────────────────────────────────
mkdirSync(join(outDir, "homes"), { recursive: true });
const rowsFile = join(outDir, "rows.jsonl");
// Resume: any (task, policy) pair already in rows.jsonl is skipped, and its
// spend counts toward the cap — so a crashed sweep relaunches into the same
// --out dir and only runs what's missing, without re-paying for done work.
const completed = new Set<string>();
let resumedUSD = 0;
if (existsSync(rowsFile)) {
  for (const line of readFileSync(rowsFile, "utf8").split("\n").filter(Boolean)) {
    try {
      const r = JSON.parse(line);
      completed.add(`${r.task}::${r.policy}`);
      resumedUSD += r.costUSD ?? 0;
    } catch { /* torn line */ }
  }
}
writeFileSync(join(outDir, "meta.json"), JSON.stringify({ startedAt: new Date().toISOString(), policies, tasks: tasks.map((t) => t.id), capUSD, mock, resumedRows: completed.size }, null, 2));
console.log(`routing-bench → ${outDir}`);
console.log(`${tasks.length} tasks × ${policies.length} policies = ${tasks.length * policies.length} runs${mock ? " (MOCK)" : ""} · cap $${capUSD}${completed.size ? ` · resuming (${completed.size} done, $${resumedUSD.toFixed(2)} prior)` : ""}`);

let spent = resumedUSD;
let done = completed.size;
let dropped = 0;
const total = tasks.length * policies.length;

outer: for (const task of tasks) {
  for (const policy of policies) {
    if (completed.has(`${task.id}::${policy}`)) continue; // already measured
    if (!mock && spent >= capUSD) {
      dropped = total - done;
      console.log(`\nBUDGET CAP REACHED ($${spent.toFixed(2)} ≥ $${capUSD}) — dropping the remaining ${dropped} runs (no silent truncation: see meta.json).`);
      break outer;
    }
    const home = join(outDir, "homes", policy);
    mkdirSync(home, { recursive: true });
    if (!mock) seedHome(home);
    const row = mock ? mockOne(task, policy) : runOne(task, policy, home);
    spent += row.costUSD;
    done++;
    appendFileSync(rowsFile, JSON.stringify(row) + "\n");
    const mark = row.hiddenOk ? "✓" : "✗";
    console.log(`[${String(done).padStart(3)}/${total}] ${mark} ${task.id.padEnd(22)} ${policy.padEnd(14)} $${row.costUSD.toFixed(4)} ${(row.wallMs / 1000).toFixed(1)}s ${row.models.join("→") || "-"}${row.error ? ` · ERR ${row.error.slice(0, 80)}` : ""}`);
  }
}

appendFileSync(join(outDir, "meta.json"), ""); // touch
writeFileSync(join(outDir, "summary.json"), JSON.stringify({ finishedAt: new Date().toISOString(), runs: done, dropped, spentUSD: spent }, null, 2));
console.log(`\ndone: ${done}/${total} runs · spent $${spent.toFixed(2)}${dropped ? ` · DROPPED ${dropped}` : ""}`);
console.log(`analyze: bun run experiments/routing-bench/analyze.ts ${outDir}`);
