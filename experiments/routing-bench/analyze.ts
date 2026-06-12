// Routing-bench analyzer — turns rows.jsonl into RESULTS.md: the per-policy
// Cost / Speed / Quality table, the cost-quality Pareto frontier (RouterBench's
// convex-hull idea applied to one point per policy), per-tier and
// per-verifier-tier splits, and the headline comparisons the decision needs
// (savings vs fixed-strong, quality delta vs baseline).
//
//   bun run experiments/routing-bench/analyze.ts <run-dir>
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BenchRow } from "./types.ts";

const runDir = resolve(process.argv[2] ?? "");
if (!runDir) {
  console.error("usage: bun run experiments/routing-bench/analyze.ts <run-dir>");
  process.exit(2);
}

const rows: BenchRow[] = readFileSync(join(runDir, "rows.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const meta = (() => {
  try { return JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8")); } catch { return {}; }
})();

interface Agg {
  policy: string;
  n: number;
  passRate: number; // hidden-judge verdicts — THE quality number
  agentAgree: number; // how often the agent's own belief matched the judge
  totalUSD: number;
  avgUSD: number;
  medianWallS: number;
  avgAttempts: number;
  escalated: number; // runs that needed >1 attempt
  errors: number;
  pareto?: boolean;
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

function aggregate(rs: BenchRow[]): Agg[] {
  const byPolicy = new Map<string, BenchRow[]>();
  for (const r of rs) {
    const arr = byPolicy.get(r.policy) ?? [];
    arr.push(r);
    byPolicy.set(r.policy, arr);
  }
  const aggs: Agg[] = [];
  for (const [policy, list] of byPolicy) {
    const n = list.length;
    aggs.push({
      policy,
      n,
      passRate: list.filter((r) => r.hiddenOk).length / n,
      agentAgree: list.filter((r) => r.hiddenOk === r.agentOk).length / n,
      totalUSD: list.reduce((s, r) => s + r.costUSD, 0),
      avgUSD: list.reduce((s, r) => s + r.costUSD, 0) / n,
      medianWallS: median(list.map((r) => r.wallMs)) / 1000,
      avgAttempts: list.reduce((s, r) => s + (r.attempts || 1), 0) / n,
      escalated: list.filter((r) => (r.attempts || 1) > 1).length,
      errors: list.filter((r) => r.error).length,
    });
  }
  // Pareto frontier on (avgUSD ↓, passRate ↑): a policy is dominated when
  // another is at least as good on both axes and strictly better on one.
  for (const a of aggs) {
    a.pareto = !aggs.some(
      (b) => b !== a && b.avgUSD <= a.avgUSD && b.passRate >= a.passRate && (b.avgUSD < a.avgUSD || b.passRate > a.passRate),
    );
  }
  return aggs.sort((a, b) => b.passRate - a.passRate || a.avgUSD - b.avgUSD);
}

const fmtPct = (x: number) => `${Math.round(x * 100)}%`;
const fmtUSD = (x: number) => `$${x.toFixed(4)}`;

function table(aggs: Agg[]): string {
  const head = "| policy | n | quality (hidden ✓) | avg cost/task | qual/$ | agent-agree | median wall | attempts | esc | err | Pareto |";
  const sep = "|---|---|---|---|---|---|---|---|---|---|---|";
  const lines = aggs.map((a) => {
    // Quality per dollar: hidden pass rate ÷ avg cost. The single number that
    // captures "most correct work per API dollar" — higher is better.
    const qpd = a.avgUSD > 0 ? (a.passRate / a.avgUSD).toFixed(1) : "∞";
    return `| ${a.policy} | ${a.n} | ${fmtPct(a.passRate)} | ${fmtUSD(a.avgUSD)} | ${qpd} | ${fmtPct(a.agentAgree)} | ${a.medianWallS.toFixed(1)}s | ${a.avgAttempts.toFixed(2)} | ${a.escalated} | ${a.errors} | ${a.pareto ? "★" : ""} |`;
  });
  return [head, sep, ...lines].join("\n");
}

function splitTable(label: string, splits: [string, BenchRow[]][]): string {
  const out: string[] = [`### ${label}`, ""];
  for (const [name, rs] of splits) {
    if (!rs.length) continue;
    out.push(`**${name}** (${rs.length} runs)`, "", table(aggregate(rs)), "");
  }
  return out.join("\n");
}

const aggs = aggregate(rows);
const baseline = aggs.find((a) => a.policy === "baseline");
const strong = aggs.find((a) => a.policy === "fixed-strong");

const headline: string[] = [];
for (const a of aggs) {
  if (!baseline || a.policy === "baseline") continue;
  const dq = a.passRate - baseline.passRate;
  const dc = baseline.avgUSD > 0 ? (baseline.avgUSD - a.avgUSD) / baseline.avgUSD : 0;
  headline.push(`- **${a.policy}** vs baseline: quality ${dq >= 0 ? "+" : ""}${Math.round(dq * 100)}pp · cost ${dc >= 0 ? "−" : "+"}${Math.round(Math.abs(dc) * 100)}%${strong && a.passRate >= strong.passRate && a.avgUSD < strong.avgUSD ? ` · matches fixed-strong quality at ${Math.round((1 - a.avgUSD / strong.avgUSD) * 100)}% lower cost` : ""}`);
}

const md = `# Routing bench — results

Run: \`${runDir}\` · started ${meta.startedAt ?? "?"} · ${rows.length} rows${meta.mock ? " · **MOCK DATA (plumbing dry-run, not real measurements)**" : ""}

Quality = hidden-judge pass rate (tests the agent never saw). Cost = full ledger
delta per run (turn + classify + cascade aux calls). Speed = wall-clock for the
whole verified turn including fix loops.

## Overall

${table(aggs)}

★ = on the cost-quality Pareto frontier (no policy is both cheaper and better).

## vs baseline

${headline.join("\n") || "(baseline missing from this run)"}

${splitTable("By difficulty tier", [
  ["T1 (trivial)", rows.filter((r) => r.tier === "T1")],
  ["T2 (medium)", rows.filter((r) => r.tier === "T2")],
  ["T3 (hard)", rows.filter((r) => r.tier === "T3")],
])}

${splitTable("By verifier visibility", [
  ["visible checks (tests-tier routing)", rows.filter((r) => r.visible)],
  ["no checks (none-tier routing)", rows.filter((r) => !r.visible)],
])}

## Reading guide

- **agent-agree** (per-policy, in rows.jsonl): when the agent's own belief
  (its verify loop) disagrees with the hidden judge, the workspace's checks
  were too weak to catch the miss — exactly the none-tier risk the
  expected-cost and selfverify policies are designed around.
- Anchors: fixed-strong = quality/cost ceiling, fixed-cheap = floor,
  random = sanity (any real policy must beat it).
`;

writeFileSync(join(runDir, "RESULTS.md"), md);
console.log(md);
console.log(`\nwrote ${join(runDir, "RESULTS.md")}`);
