#!/usr/bin/env bun
// REAL-BENCHMARK routing bake-off on the Aider polyglot benchmark — the 225
// hardest Exercism exercises (C++/Go/Java/JS/Python/Rust). Unlike HarnessBench
// these are real, hard (GPT-4 couldn't one-shot them), and ship a real test net,
// so they expose the quality frontier (where cheap models fall off) and exercise
// cheap-first routing under a net.
//
// For each (exercise, model): copy the exercise to a temp dir WITHOUT .meta/ (the
// reference solution lives there), prompt THIS branch's gearbox one-shot to fill
// the solution file(s), then RESTORE every non-solution file from pristine (so a
// model can't pass by editing the tests) and run the language test command.
// Pass = tests green. Cost = token usage × list price (DeepSeek = real Azure $).
//
// Run: bun run experiments/routing-bench/polyglot.ts \
//        --langs python,go --models "claude-haiku-4-5,claude-opus-4-8,auto" \
//        --n 8 --trials 1 [--exercises grade-school,alphametics]
import { spawnSync } from "node:child_process";
import { mkdtempSync, cpSync, copyFileSync, readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, relative, dirname } from "node:path";

const REPO = "/Users/aakritigarodia/Desktop/Projects/gearbox";
const CLI = join(REPO, "src/cli.tsx");
const VENDOR = join(REPO, "experiments/routing-bench/vendor/polyglot-benchmark");
const REAL_HOME = process.env.GEARBOX_HOME || join(homedir(), ".gearbox");

// $/Mtok (in, out) — list prices for a comparable cost across seats & metered.
const PRICE: Record<string, [number, number]> = {
  "azure-foundry/DeepSeek-V4-Pro": [0.4, 1.75], "deepseek-v4-pro": [0.4, 1.75], "deepseek-v4-flash": [0.14, 0.28],
  "claude-haiku-4-5": [1, 5], "claude-sonnet-4-6": [3, 15], "claude-opus-4-8": [5, 25],
  "gpt-5.5": [5, 30], "gpt-5.4": [3.5, 14], "gpt-5.4-mini": [0.5, 2],
};
const costOf = (id: string, i: number, o: number): number => {
  const p = PRICE[id] ?? PRICE[id.replace(/^[^/]+\//, "")] ?? [3, 15];
  return (i / 1e6) * p[0] + (o / 1e6) * p[1];
};

// Per-language test command (run with cwd = workdir). Validated: stub FAILs,
// reference example PASSes (see FINDINGS / setup).
const TEST_CMD: Record<string, (testFiles: string[]) => string[]> = {
  python: (t) => ["python3", "-m", "pytest", "-x", "-q", ...t],
  go: () => ["go", "test", "./..."],
  javascript: () => ["npm", "test"],
  rust: () => ["cargo", "test", "--", "--include-ignored"],
};
const TIMEOUT_MS = Number(arg("timeout", "300")) * 1000;

function arg(name: string, def = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : def;
}
function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...listFiles(p, base));
    else out.push(relative(base, p));
  }
  return out;
}

const langs = arg("langs", "python,go").split(",").map((s) => s.trim()).filter(Boolean);
const models = arg("models", "claude-haiku-4-5,claude-opus-4-8,auto").split(",").map((s) => s.trim());
const trials = Number(arg("trials", "1"));
const perLang = Number(arg("n", "8"));
const only = arg("exercises", "");

// Build the (lang, exercise) work-list.
interface Ex { lang: string; id: string; dir: string; solution: string[]; test: string[]; instructions: string }
const exercises: Ex[] = [];
for (const lang of langs) {
  const practice = join(VENDOR, lang, "exercises", "practice");
  if (!existsSync(practice)) { console.error(`no practice dir for ${lang}`); continue; }
  let ids = readdirSync(practice).filter((d) => existsSync(join(practice, d, ".meta", "config.json")));
  if (only) ids = ids.filter((d) => only.split(",").map((s) => s.trim()).includes(d));
  ids = ids.sort().slice(0, perLang); // deterministic subset
  for (const id of ids) {
    const dir = join(practice, id);
    const cfg = JSON.parse(readFileSync(join(dir, ".meta", "config.json"), "utf8"));
    const docs = ["instructions.md", "instructions.append.md"]
      .map((f) => join(dir, ".docs", f)).filter(existsSync).map((f) => readFileSync(f, "utf8")).join("\n\n");
    exercises.push({ lang, id, dir, solution: cfg.files.solution, test: cfg.files.test, instructions: docs });
  }
}

console.log(`polyglot bake-off · ${exercises.length} exercises (${langs.join("+")}) × ${models.length} models × ${trials} trial(s) = ${exercises.length * models.length * trials} runs\n`);

interface Run { lang: string; ex: string; model: string; trial: number; solved: boolean; error: boolean; inTok: number; outTok: number; cost: number; ms: number; servedModel: string }
const runs: Run[] = [];

// PRECONDITION: drop exercises whose stub already passes the test (no work to
// do → a failed model call would falsely score "solved"). Run the test on a
// pristine stub copy once per exercise.
const valid: Ex[] = [];
for (const ex of exercises) {
  const probe = mkdtempSync(join(tmpdir(), `polyprobe-${ex.id}-`));
  cpSync(ex.dir, probe, { recursive: true, filter: (src) => !src.includes(`${ex.id}/.meta`) && !src.endsWith("/.meta") });
  const check = TEST_CMD[ex.lang]!(ex.test);
  const j = spawnSync(check[0]!, check.slice(1), { cwd: probe, env: { ...process.env, HOME: homedir() }, encoding: "utf8", timeout: TIMEOUT_MS });
  try { rmSync(probe, { recursive: true, force: true }); } catch {}
  if ((j.status ?? 1) === 0) { console.log(`  [skip ${ex.lang}/${ex.id}: stub already passes — invalid task]`); continue; }
  valid.push(ex);
}
if (valid.length !== exercises.length) console.log(`  (${exercises.length - valid.length} invalid task(s) dropped; ${valid.length} remain)\n`);
exercises.length = 0; exercises.push(...valid);

for (const ex of exercises) {
  for (const model of models) {
    for (let trial = 0; trial < trials; trial++) {
      // Pristine copy WITHOUT .meta (the reference solution + answer live there).
      const work = mkdtempSync(join(tmpdir(), `poly-${ex.lang}-${ex.id}-`));
      cpSync(ex.dir, work, { recursive: true, filter: (src) => !src.includes(`${ex.id}/.meta`) && !src.endsWith("/.meta") });
      const pristine = mkdtempSync(join(tmpdir(), `polyp-${ex.id}-`));
      cpSync(work, pristine, { recursive: true });

      const prompt =
        `${ex.instructions}\n\n` +
        `Implement your solution in: ${ex.solution.join(", ")}. ` +
        `The test file(s) ${ex.test.join(", ")} are present — you may read them, but DO NOT modify them. ` +
        `Make the tests pass. When done, print \`VERDICT: done\` as the final line.`;

      const t0 = Date.now();
      const cmd = ["run", CLI, "-p", prompt, "--yolo", "--json"];
      if (model.toLowerCase() !== "auto") cmd.push("--model", model);
      const r = spawnSync("bun", cmd, { cwd: work, env: { ...process.env, GEARBOX_HOME: REAL_HOME, HOME: homedir() }, encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
      const ms = Date.now() - t0;

      let inTok = 0, outTok = 0, servedModel = model, parsed = false;
      try {
        const line = (r.stdout || "").trim().split("\n").filter(Boolean).at(-1) ?? "{}";
        const j = JSON.parse(line);
        inTok = j.usage?.inputTokens ?? 0; outTok = j.usage?.outputTokens ?? 0; servedModel = j.model ?? model;
        parsed = true;
      } catch { /* cli failure (rate-limit/error) → no JSON → infra error, not a genuine miss */ }
      const error = !parsed; // failed model call (rate-limit, crash) — exclude from solve%

      // ANTI-CHEAT: restore every non-solution file from pristine (tests, data),
      // so the model can only pass by actually implementing the solution file(s).
      const sol = new Set(ex.solution);
      for (const f of listFiles(pristine)) {
        if (sol.has(f)) continue;
        const dst = join(work, f); mkdirSync(dirname(dst), { recursive: true });
        copyFileSync(join(pristine, f), dst);
      }

      const check = TEST_CMD[ex.lang]!(ex.test);
      const judge = spawnSync(check[0]!, check.slice(1), { cwd: work, env: { ...process.env, HOME: homedir() }, encoding: "utf8", timeout: TIMEOUT_MS });
      // A failed model call (error) is NOT a solve even if the stub coincidentally
      // passes — guarded here AND by the stub-fails precondition above.
      const solved = !error && (judge.status ?? 1) === 0;
      const cost = costOf(servedModel, inTok, outTok);
      runs.push({ lang: ex.lang, ex: ex.id, model, trial, solved, error, inTok, outTok, cost, ms, servedModel });
      const mark = error ? "⚠ERR" : solved ? "✓" : "✗";
      console.log(`  ${(ex.lang + "/" + ex.id).padEnd(26)} ${model.padEnd(30)} ${mark}  ${(inTok / 1000).toFixed(0)}k/${(outTok / 1000).toFixed(1)}k  $${cost.toFixed(4)}  ${(ms / 1000).toFixed(0)}s  (${servedModel})`);
      try { rmSync(work, { recursive: true, force: true }); rmSync(pristine, { recursive: true, force: true }); } catch {}
    }
  }
}

// ── aggregate ────────────────────────────────────────────────────────────────
console.log(`\n=== RESULTS (${exercises.length} exercises × ${trials} trials) ===`);
console.log("solve% is over VALID runs (excludes ⚠ERR failed calls).");
console.log("model".padEnd(32) + "solve%   valid  err  $/solved   avg s   total $");
for (const model of models) {
  const rs = runs.filter((r) => r.model === model);
  if (!rs.length) continue;
  const errs = rs.filter((r) => r.error).length;
  const validRuns = rs.filter((r) => !r.error);
  const solved = validRuns.filter((r) => r.solved).length;
  const totalCost = rs.reduce((s, r) => s + r.cost, 0);
  const avgMs = validRuns.length ? validRuns.reduce((s, r) => s + r.ms, 0) / validRuns.length : 0;
  const perSolved = solved ? totalCost / solved : Infinity;
  const pct = validRuns.length ? ((100 * solved) / validRuns.length).toFixed(0) + "%" : "—";
  console.log(
    model.padEnd(32) +
    pct.padEnd(9) +
    `${validRuns.length}`.padEnd(7) +
    `${errs}`.padEnd(5) +
    `${perSolved === Infinity ? "—" : "$" + perSolved.toFixed(4)}`.padEnd(11) +
    `${(avgMs / 1000).toFixed(0)}`.padEnd(8) +
    `$${totalCost.toFixed(4)}`,
  );
}
const azure = runs.filter((r) => r.servedModel.includes("DeepSeek")).reduce((s, r) => s + r.cost, 0);
if (azure > 0) console.log(`\nAzure DeepSeek real metered spend (derived): $${azure.toFixed(4)}`);
const outFile = join(REPO, "experiments/routing-bench", arg("out", "polyglot-results.local.json"));
writeFileSync(outFile, JSON.stringify(runs, null, 2));
console.log(`\nwrote ${runs.length} runs → ${outFile}`);
