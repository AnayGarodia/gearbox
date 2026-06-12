// SWE-bench-Lite slice — 5 modern Django instances run WITHOUT docker:
// workspace = GitHub tarball at base_commit (cached), judge = the instance's
// FAIL_TO_PASS tests via Django's own runtests.py on a shared python3.12 venv
// (PYTHONPATH import, no editable install — so the venv is workspace-agnostic).
//
// The agent runs with --verify --skip-checks: the full routed turn (classify,
// policy, cascade drivers) but no check commands — Django's real suite can't
// run inside a bounded verify step, so escalation-on-red doesn't exist here.
// That makes this slice a SINGLE-SHOT measure of routing pick quality on
// hard, realistic tasks; the fixture corpus is where escalation dynamics are
// measured. Workspaces are scrubbed of JS/packaging tooling files so check
// detection honestly reports "none" instead of finding grunt/pytest that
// can't run.
//
//   bun run experiments/routing-bench/run-swe.ts --policies a,b --cap 10 --out <dir>
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync, rmSync, readdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { BenchRow } from "./types.ts";

const REPO = resolve(import.meta.dir, "../..");
const CACHE = resolve(REPO, "experiments/routing-bench/swe-cache");
const PY = "/opt/homebrew/bin/python3.12"; // django 4.2/5.0 support ≤3.12

const INSTANCE_IDS = [
  "django__django-16046", // numberformat crash on empty string
  "django__django-15790", // template tag module collision message
  "django__django-15902", // deprecation warning from formset management form
  "django__django-16527", // admin show_save_as_new permission
  "django__django-15851", // dbshell args order
];

interface SweInstance {
  instance_id: string;
  base_commit: string;
  problem_statement: string;
  test_patch: string;
  fail_to_pass: string[];
}

const args = process.argv.slice(2);
const argVal = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const capUSD = Number(argVal("cap") ?? 10);
const timeoutMs = Number(argVal("timeout") ?? 420) * 1000;
const policies = (argVal("policies")?.split(",") ?? ["baseline", "expected-cost", "selfverify", "draft-review", "fixed-strong", "fixed-cheap"]).map((s) => s.trim()).filter(Boolean);
const outDir = resolve(REPO, argVal("out") ?? "experiments/routing-bench/results/swe");

// ── dataset (fetched once, cached) ───────────────────────────────────────────
async function loadInstances(): Promise<SweInstance[]> {
  const file = join(CACHE, "instances.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  console.log("fetching SWE-bench Lite rows…");
  const found = new Map<string, SweInstance>();
  for (let offset = 0; offset < 300 && found.size < INSTANCE_IDS.length; offset += 100) {
    const res = await fetch(`https://datasets-server.huggingface.co/rows?dataset=princeton-nlp%2FSWE-bench_Lite&config=default&split=test&offset=${offset}&length=100`);
    const data: any = await res.json();
    for (const r of data.rows ?? []) {
      const row = r.row;
      if (!INSTANCE_IDS.includes(row.instance_id)) continue;
      found.set(row.instance_id, {
        instance_id: row.instance_id,
        base_commit: row.base_commit,
        problem_statement: row.problem_statement,
        test_patch: row.test_patch,
        fail_to_pass: JSON.parse(row.FAIL_TO_PASS),
      });
    }
  }
  const list = INSTANCE_IDS.map((id) => found.get(id)).filter(Boolean) as SweInstance[];
  if (list.length !== INSTANCE_IDS.length) throw new Error(`only found ${list.length}/${INSTANCE_IDS.length} instances`);
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(file, JSON.stringify(list, null, 2));
  return list;
}

// ── environment ──────────────────────────────────────────────────────────────
function ensureVenv(): string {
  const venv = join(CACHE, "venv");
  if (!existsSync(join(venv, "bin", "python"))) {
    console.log("creating shared py3.12 venv (asgiref + sqlparse)…");
    spawnSync(PY, ["-m", "venv", venv], { encoding: "utf8", timeout: 120_000 });
    spawnSync(join(venv, "bin", "pip"), ["install", "-q", "asgiref", "sqlparse"], { encoding: "utf8", timeout: 300_000 });
  }
  return venv;
}

function ensureTarball(sha: string): string {
  mkdirSync(CACHE, { recursive: true });
  const tgz = join(CACHE, `${sha}.tgz`);
  if (!existsSync(tgz)) {
    console.log(`downloading django @ ${sha.slice(0, 10)}…`);
    const r = spawnSync("curl", ["-sL", `https://github.com/django/django/tarball/${sha}`, "-o", tgz], { encoding: "utf8", timeout: 300_000 });
    if (r.status !== 0) throw new Error(`tarball download failed for ${sha}`);
  }
  return tgz;
}

function git(cwd: string, ...argv: string[]): ReturnType<typeof spawnSync> {
  return spawnSync("git", ["-c", "user.email=bench@gearbox", "-c", "user.name=bench", ...argv], { cwd, encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
}

// Tooling files whose presence would make check detection find commands that
// can't run here (grunt, a 4000-file pytest sweep). Scrubbing them makes the
// workspace honestly "none"-tier.
const SCRUB = ["package.json", "Gruntfile.js", "pyproject.toml", "setup.py", "setup.cfg", "tox.ini"];

function makeWorkspace(inst: SweInstance, policy: string): string {
  const ws = join(outDir, "work", `${inst.instance_id}--${policy}`);
  rmSync(ws, { recursive: true, force: true });
  mkdirSync(ws, { recursive: true });
  spawnSync("tar", ["xzf", ensureTarball(inst.base_commit), "--strip-components=1", "-C", ws], { encoding: "utf8", timeout: 300_000 });
  for (const f of SCRUB) rmSync(join(ws, f), { force: true });
  git(ws, "init", "-q");
  git(ws, "add", "-A");
  git(ws, "commit", "-qm", "fixture");
  return ws;
}

// "test_name (module.tests.Class)" → "module.tests.Class.test_name"
function toSpec(f2p: string): string {
  const m = f2p.match(/^(\S+)\s+\((\S+)\)$/);
  return m ? `${m[2]}.${m[1]}` : f2p;
}

function runJudge(inst: SweInstance, ws: string, venv: string): boolean {
  writeFileSync(join(ws, "__judge.patch"), inst.test_patch);
  const ap = git(ws, "apply", "__judge.patch");
  if (ap.status !== 0) return false; // agent's edits conflict with the test patch → can't pass
  const specs = inst.fail_to_pass.map(toSpec);
  const r = spawnSync(join(venv, "bin", "python"), ["tests/runtests.py", "--parallel", "1", ...specs], {
    cwd: ws,
    encoding: "utf8",
    timeout: 420_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PYTHONPATH: ws },
  });
  return r.status === 0;
}

function seedHome(home: string): void {
  const src = join(homedir(), ".gearbox", "accounts.json");
  const dst = join(home, "accounts.json");
  if (existsSync(dst) || !existsSync(src)) return;
  const f = JSON.parse(readFileSync(src, "utf8"));
  const metered = (f.accounts ?? []).filter((a: any) => a.exec !== "cli" && a.enabled !== false);
  const defaults: Record<string, string> = {};
  for (const [prov, id] of Object.entries(f.defaults ?? {})) {
    if (metered.some((a: any) => a.id === id)) defaults[prov] = id as string;
  }
  writeFileSync(dst, JSON.stringify({ ...f, accounts: metered, defaults }, null, 2), { mode: 0o600 });
}

function ledgerLines(home: string): number {
  try { return readFileSync(join(home, "ledger.jsonl"), "utf8").split("\n").filter(Boolean).length; } catch { return 0; }
}
function ledgerCostSince(home: string, fromLine: number): number {
  try {
    let usd = 0;
    for (const l of readFileSync(join(home, "ledger.jsonl"), "utf8").split("\n").filter(Boolean).slice(fromLine)) {
      try { usd += JSON.parse(l).costUSD ?? 0; } catch { /* torn */ }
    }
    return usd;
  } catch { return 0; }
}

// ── main ─────────────────────────────────────────────────────────────────────
const instances = await loadInstances();
const venv = ensureVenv();
mkdirSync(join(outDir, "homes"), { recursive: true });
const rowsFile = join(outDir, "rows.jsonl");
// Resume: skip (instance, policy) pairs already recorded; their spend counts
// toward the cap. A killed run relaunches into the same --out and continues.
const completed = new Set<string>();
let resumedUSD = 0;
if (existsSync(rowsFile)) {
  for (const line of readFileSync(rowsFile, "utf8").split("\n").filter(Boolean)) {
    try { const r = JSON.parse(line); completed.add(`${r.task}::${r.policy}`); resumedUSD += r.costUSD ?? 0; } catch { /* torn */ }
  }
}
writeFileSync(join(outDir, "meta.json"), JSON.stringify({ startedAt: new Date().toISOString(), policies, tasks: instances.map((i) => i.instance_id), capUSD, slice: "swe-lite-django", resumedRows: completed.size }, null, 2));
console.log(`swe slice → ${outDir}\n${instances.length} instances × ${policies.length} policies · cap $${capUSD}${completed.size ? ` · resuming (${completed.size} done, $${resumedUSD.toFixed(2)} prior)` : ""}`);

let spent = resumedUSD;
let done = completed.size;
const total = instances.length * policies.length;

outer: for (const inst of instances) {
  for (const policy of policies) {
    if (completed.has(`${inst.instance_id}::${policy}`)) continue;
    if (spent >= capUSD) {
      console.log(`\nBUDGET CAP REACHED ($${spent.toFixed(2)}) — dropping the remaining ${total - done} runs.`);
      break outer;
    }
    const home = join(outDir, "homes", policy);
    mkdirSync(home, { recursive: true });
    seedHome(home);
    const ws = makeWorkspace(inst, policy);
    const before = ledgerLines(home);
    const started = Date.now();
    const prompt = `Fix the following issue in this Django checkout. Make the minimal correct change to the django/ source (do not edit tests).\n\n${inst.problem_statement}`;
    const r = spawnSync("bun", ["run", join(REPO, "src/cli.tsx"), "-p", prompt, "--verify", "--skip-checks", "--json", "--router", policy], {
      cwd: ws,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GEARBOX_HOME: home, GEARBOX_SKIP_ONBOARD: "1", GEARBOX_NO_MOTION: "1" },
    });
    const wallMs = Date.now() - started;
    let parsed: any = null;
    for (const line of (r.stdout ?? "").split("\n").reverse()) {
      if (!line.trim().startsWith("{")) continue;
      try { parsed = JSON.parse(line); break; } catch { /* keep looking */ }
    }
    const costUSD = ledgerCostSince(home, before) || parsed?.totals?.costUSD || 0;
    const hiddenOk = runJudge(inst, ws, venv);
    spent += costUSD;
    done++;
    const row: BenchRow = {
      task: inst.instance_id, tier: "SWE", visible: false, policy,
      hiddenOk, agentOk: Boolean(parsed?.ok), costUSD, wallMs,
      inputTokens: parsed?.totals?.inputTokens ?? 0, outputTokens: parsed?.totals?.outputTokens ?? 0,
      attempts: parsed?.attempts?.length ?? 0, models: (parsed?.attempts ?? []).map((a: any) => a.model),
      kind: parsed?.kind, verifierTier: parsed?.verifierTier,
      error: parsed ? parsed.error : `spawn: ${(r.stderr ?? "").split("\n").filter(Boolean).slice(-2).join(" / ").slice(0, 300) || `status ${r.status}`}`,
    };
    appendFileSync(rowsFile, JSON.stringify(row) + "\n");
    console.log(`[${String(done).padStart(2)}/${total}] ${hiddenOk ? "✓" : "✗"} ${inst.instance_id.padEnd(24)} ${policy.padEnd(14)} $${costUSD.toFixed(4)} ${(wallMs / 1000).toFixed(0)}s ${row.models.join("→") || "-"}${row.error ? ` · ERR ${String(row.error).slice(0, 60)}` : ""}`);
  }
}

writeFileSync(join(outDir, "summary.json"), JSON.stringify({ finishedAt: new Date().toISOString(), runs: done, spentUSD: spent }, null, 2));
console.log(`\ndone: ${done}/${total} · spent $${spent.toFixed(2)}`);
