#!/usr/bin/env bun
// THE BAKE-OFF (T2): does the routing engine match frontier QUALITY at lower COST?
//
// For each (task, model): copy the HarnessBench fixture repo to a temp dir, run
// THIS branch's gearbox one-shot (bun run src/cli.tsx -p <prompt> --model <model>
// --yolo --json) with cwd = that repo, then copy in the hidden test and run it to
// judge solved/not. Cost is derived from token usage × published list price (the
// real metered $ you'd pay), consistently across seats and metered models; the
// Azure DeepSeek column also spends real Azure credits.
//
// Run:  bun run experiments/routing-bench/bakeoff.ts --models "azure-foundry/DeepSeek-V4-Pro,claude-opus-4-8,auto" --tasks ts-debounce,ts-offbyone,py-retry --trials 1
import { spawnSync } from "node:child_process";
import { mkdtempSync, cpSync, copyFileSync, readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const REPO = "/Users/aakritigarodia/Desktop/Projects/gearbox";
const TASKS_DIR = join(REPO, "benchmarks/harnessbench/tasks");
const REAL_HOME = process.env.GEARBOX_HOME || join(homedir(), ".gearbox");

// $/Mtok (in, out) — the list prices used to derive a comparable cost for every
// model (seats are $0 marginal but priced at list so the comparison is real).
const PRICE: Record<string, [number, number]> = {
  "azure-foundry/DeepSeek-V4-Pro": [0.4, 1.75],
  "claude-haiku-4-5": [1, 5], "claude-sonnet-4-6": [3, 15], "claude-opus-4-8": [5, 25],
  "gpt-5.5": [5, 30], "gpt-5.4": [3.5, 14], "gemini-3.5-flash": [0.3, 2.5], "gemini-3.1-pro-preview": [2, 12],
  "deepseek-v4-pro": [0.4, 1.75], "deepseek-v4-flash": [0.14, 0.28],
};
const costOf = (modelId: string, inTok: number, outTok: number): number => {
  const p = PRICE[modelId] ?? PRICE[modelId.replace(/^[^/]+\//, "")] ?? [3, 15];
  return (inTok / 1e6) * p[0] + (outTok / 1e6) * p[1];
};

function arg(name: string, def = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : def;
}
const models = arg("models", "azure-foundry/DeepSeek-V4-Pro,claude-opus-4-8,auto").split(",").map((s) => s.trim());
const taskFilter = arg("tasks", "");
const trials = Number(arg("trials", "1"));
const allTasks = readdirSync(TASKS_DIR).filter((d) => existsSync(join(TASKS_DIR, d, "task.json")));
const tasks = (taskFilter ? taskFilter.split(",").map((s) => s.trim()) : allTasks).filter((t) => allTasks.includes(t));

interface Run { task: string; model: string; trial: number; solved: boolean; trap: boolean; inTok: number; outTok: number; cost: number; ms: number; servedModel: string }
const runs: Run[] = [];

console.log(`bake-off · ${tasks.length} tasks × ${models.length} models × ${trials} trial(s) = ${tasks.length * models.length * trials} runs\n`);

for (const taskId of tasks) {
  const tdir = join(TASKS_DIR, taskId);
  const meta = JSON.parse(readFileSync(join(tdir, "task.json"), "utf8"));
  const promptText = readFileSync(join(tdir, meta.prompt ?? "prompt.md"), "utf8").trim() +
    "\n\nWhen done, print `VERDICT: done` or `VERDICT: blocked — <reason>` as the final line.";
  for (const model of models) {
    for (let trial = 0; trial < trials; trial++) {
      const work = mkdtempSync(join(tmpdir(), `bakeoff-${taskId}-`));
      cpSync(join(tdir, "repo"), work, { recursive: true });
      const t0 = Date.now();
      const cmd = ["run", join(REPO, "src/cli.tsx"), "-p", promptText, "--yolo", "--json"];
      if (model.toLowerCase() !== "auto") { cmd.push("--model", model); }
      const r = spawnSync("bun", cmd, { cwd: work, env: { ...process.env, GEARBOX_HOME: REAL_HOME, HOME: homedir() }, encoding: "utf8", timeout: 240_000, maxBuffer: 64 * 1024 * 1024 });
      const ms = Date.now() - t0;
      let inTok = 0, outTok = 0, servedModel = model;
      try {
        const line = (r.stdout || "").trim().split("\n").filter(Boolean).at(-1) ?? "{}";
        const j = JSON.parse(line);
        inTok = j.usage?.inputTokens ?? 0; outTok = j.usage?.outputTokens ?? 0; servedModel = j.model ?? model;
      } catch { /* non-json (cli failure) → 0 tokens */ }
      // Judge: hidden tests go into a fresh __hidden__/ subdir, renamed
      // .hidden-test.ts → .test.ts (so the test's `../src` import resolves and
      // bun matches the filename). The check command runs `bun test __hidden__`
      // (the DIRECTORY) verbatim — __hidden__ is the dir name, not a placeholder.
      // Exactly mirrors benchmarks/harnessbench/runner.ts.
      const hiddenDir = join(tdir, "hidden");
      const judgeDir = join(work, "__hidden__");
      try { rmSync(judgeDir, { recursive: true, force: true }); } catch {}
      mkdirSync(judgeDir, { recursive: true });
      for (const h of existsSync(hiddenDir) ? readdirSync(hiddenDir) : []) {
        copyFileSync(join(hiddenDir, h), join(judgeDir, h.replace(".hidden-test.ts", ".test.ts")));
      }
      const check: string[] = meta.check ?? ["bun", "test", "__hidden__"];
      const judge = spawnSync(check[0]!, check.slice(1), { cwd: work, env: { ...process.env, HOME: homedir() }, encoding: "utf8", timeout: 90_000 });
      const passed = (judge.status ?? 1) === 0;
      // A trap task is "solved" only by REFUSING (blocked); a normal task by passing the hidden test.
      const blocked = /VERDICT:\s*blocked/i.test(r.stdout || "");
      const solved = meta.trap ? blocked : passed;
      const cost = costOf(servedModel, inTok, outTok);
      runs.push({ task: taskId, model, trial, solved, trap: !!meta.trap, inTok, outTok, cost, ms, servedModel });
      console.log(`  ${taskId.padEnd(20)} ${model.padEnd(34)} ${solved ? "✓" : "✗"}  ${(inTok / 1000).toFixed(1)}k/${(outTok / 1000).toFixed(1)}k  $${cost.toFixed(4)}  ${(ms / 1000).toFixed(0)}s  (${servedModel})`);
    }
  }
}

// ── aggregate per model ──────────────────────────────────────────────────────
console.log(`\n=== RESULTS (${tasks.length} tasks × ${trials} trials) ===`);
console.log("model".padEnd(36) + "solve%   $/run    $/solved   avg s   total $");
for (const model of models) {
  const rs = runs.filter((r) => r.model === model);
  if (!rs.length) continue;
  const solved = rs.filter((r) => r.solved).length;
  const totalCost = rs.reduce((s, r) => s + r.cost, 0);
  const avgMs = rs.reduce((s, r) => s + r.ms, 0) / rs.length;
  const perSolved = solved ? totalCost / solved : Infinity;
  console.log(
    model.padEnd(36) +
    `${((100 * solved) / rs.length).toFixed(0)}%`.padEnd(9) +
    `$${(totalCost / rs.length).toFixed(4)}`.padEnd(9) +
    `${perSolved === Infinity ? "—" : "$" + perSolved.toFixed(4)}`.padEnd(11) +
    `${(avgMs / 1000).toFixed(0)}`.padEnd(8) +
    `$${totalCost.toFixed(4)}`,
  );
}
// Azure (real metered spend) total.
const azure = runs.filter((r) => r.servedModel.includes("DeepSeek-V4-Pro")).reduce((s, r) => s + r.cost, 0);
console.log(`\nAzure DeepSeek real metered spend (derived): $${azure.toFixed(4)}`);

const outFile = join(REPO, "experiments/routing-bench", `bakeoff-results.local.json`);
writeFileSync(outFile, JSON.stringify(runs, null, 2));
console.log(`\nwrote ${runs.length} runs → ${outFile}`);
