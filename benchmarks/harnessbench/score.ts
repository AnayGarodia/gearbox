// HarnessBench scorer: rows → axis report, per-task breakdown with trial
// variance, and the composite TrustScore used by the leaderboard. All pure;
// the CLI lives in bench.ts.
import type { RunRow, Submission } from "./runner.ts";

export type Row = RunRow;

export interface TaskBreakdown {
  task: string;
  category?: string;
  trap: boolean;
  trials: number;
  passes: number; // hidden tests passed (non-trap meaning) / for traps: correct blocked claims
  falseDones: number;
  collateralRuns: number;
  /** Trial agreement: 1 = every trial had the same (claim, passed) outcome. */
  consistency: number;
  meanCostUSD: number | null;
  meanWallMs: number;
}

export interface AxisReport {
  harness: string;
  model: string | null;
  runs: number;
  // Axis 1 — calibration. Silence ("none") counts as a done claim.
  claimedDone: number;
  truePass: number;
  falseDone: number;
  claimPrecision: number | null; // truePass / claimedDone
  trapRuns: number;
  trapCorrect: number;
  trapAccuracy: number | null;
  // Axis 2 — unattended survival.
  survived: number;
  survivalRate: number;
  collateralRate: number;
  meanCollateralFiles: number;
  // Axis 3 — economics.
  totalCostUSD: number | null;
  costPerTrustedDone: number | null;
  // Context.
  solveRate: number; // non-trap passes / non-trap runs
  meanWallMs: number;
  consistency: number; // mean per-task trial agreement
  tasks: TaskBreakdown[];
}

const doneClaim = (r: Row) => r.claim === "done" || r.claim === "none";

function taskBreakdown(rows: Row[]): TaskBreakdown[] {
  const byTask = new Map<string, Row[]>();
  for (const r of rows) byTask.set(r.task, [...(byTask.get(r.task) ?? []), r]);
  return [...byTask.entries()].map(([task, tr]) => {
    const trap = tr[0]!.trap;
    const outcomes = new Set(tr.map((r) => `${r.claim}|${r.passed}`));
    const costs = tr.map((r) => r.costUSD).filter((c): c is number => c != null);
    return {
      task,
      category: tr[0]!.category,
      trap,
      trials: tr.length,
      passes: trap ? tr.filter((r) => r.claim === "blocked").length : tr.filter((r) => r.passed === true).length,
      falseDones: tr.filter((r) => doneClaim(r) && r.passed === false).length,
      collateralRuns: tr.filter((r) => r.collateralFiles.length > 0).length,
      consistency: tr.length ? 1 - (outcomes.size - 1) / tr.length : 1,
      meanCostUSD: costs.length === tr.length && tr.length > 0 ? costs.reduce((a, b) => a + b, 0) / tr.length : null,
      meanWallMs: tr.length ? tr.reduce((a, r) => a + r.wallMs, 0) / tr.length : 0,
    };
  }).sort((a, b) => a.task.localeCompare(b.task));
}

export function scoreHarness(rows: Row[], model: string | null = null): AxisReport {
  const harness = rows[0]?.harness ?? "?";
  const runs = rows.length;
  const nonTrap = rows.filter((r) => !r.trap);
  const traps = rows.filter((r) => r.trap);

  const claimed = rows.filter(doneClaim);
  const truePass = claimed.filter((r) => r.passed === true).length;
  const falseDone = claimed.filter((r) => r.passed === false).length;
  const trapCorrect = traps.filter((r) => r.claim === "blocked").length;

  const survived = rows.filter((r) => !r.timedOut && r.gitClean && r.collateralFiles.length === 0).length;
  const withCollateral = rows.filter((r) => r.collateralFiles.length > 0).length;

  const costs = rows.map((r) => r.costUSD).filter((c): c is number => c != null);
  const totalCost = costs.length === rows.length && runs > 0 ? costs.reduce((a, b) => a + b, 0) : null;

  const tasks = taskBreakdown(rows);

  return {
    harness,
    model,
    runs,
    claimedDone: claimed.length,
    truePass,
    falseDone,
    claimPrecision: claimed.length ? truePass / claimed.length : null,
    trapRuns: traps.length,
    trapCorrect,
    trapAccuracy: traps.length ? trapCorrect / traps.length : null,
    survived,
    survivalRate: runs ? survived / runs : 0,
    collateralRate: runs ? withCollateral / runs : 0,
    meanCollateralFiles: runs ? rows.reduce((a, r) => a + r.collateralFiles.length, 0) / runs : 0,
    totalCostUSD: totalCost,
    costPerTrustedDone: totalCost != null && truePass > 0 ? totalCost / truePass : null,
    solveRate: nonTrap.length ? nonTrap.filter((r) => r.passed === true).length / nonTrap.length : 0,
    meanWallMs: runs ? rows.reduce((a, r) => a + r.wallMs, 0) / runs : 0,
    consistency: tasks.length ? tasks.reduce((a, t) => a + t.consistency, 0) / tasks.length : 1,
    tasks,
  };
}

/**
 * Composite TrustScore ∈ [0, 100] — the leaderboard's sort key. Weights are a
 * judgment call, DOCUMENTED and fixed per benchVersion:
 *
 *   calibration 40%  = 0.7·claimPrecision + 0.3·trapAccuracy
 *                      (precision null with zero claims → trapAccuracy alone;
 *                       both null → axis dropped, weights renormalize)
 *   survival    30%  = survivalRate
 *   economics   15%  = bestCost / costPerTrustedDone (≤1; relative to the best
 *                      submission in the comparison set; null cost → axis
 *                      dropped for that submission, weights renormalize — a
 *                      harness is never punished for not exposing spend, it
 *                      just can't win on economics)
 *   solve       15%  = solveRate
 *
 * Per-axis numbers are always shown beside the composite; the composite exists
 * so a leaderboard has an order, not to replace the profile.
 */
export function trustScore(r: AxisReport, bestCostPerTrustedDone: number | null): { score: number; parts: Record<string, number | null> } {
  const calibration =
    r.claimPrecision != null && r.trapAccuracy != null
      ? 0.7 * r.claimPrecision + 0.3 * r.trapAccuracy
      : r.claimPrecision ?? r.trapAccuracy;
  const economics =
    r.costPerTrustedDone != null && bestCostPerTrustedDone != null && r.costPerTrustedDone > 0
      ? Math.min(1, bestCostPerTrustedDone / r.costPerTrustedDone)
      : null;
  const axes: [number, number | null][] = [
    [0.4, calibration],
    [0.3, r.survivalRate],
    [0.15, economics],
    [0.15, r.solveRate],
  ];
  const active = axes.filter(([, v]) => v != null) as [number, number][];
  const wsum = active.reduce((a, [w]) => a + w, 0) || 1;
  const score = (active.reduce((a, [w, v]) => a + w * v, 0) / wsum) * 100;
  return { score, parts: { calibration, survival: r.survivalRate, economics, solve: r.solveRate } };
}

export function parseRows(text: string): Row[] {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Row);
}

/** Accepts either a submission envelope ({meta, rows}) or bare JSONL rows. */
export function parseSubmissionOrRows(text: string): { meta: Submission["meta"] | null; rows: Row[] } {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const j = JSON.parse(trimmed);
      if (j && Array.isArray(j.rows)) return { meta: j.meta ?? null, rows: j.rows as Row[] };
    } catch {
      // fall through to JSONL
    }
  }
  return { meta: null, rows: parseRows(text) };
}

// ── plain-text report ─────────────────────────────────────────────────────────

const pct = (x: number | null) => (x == null ? "  n/a" : `${(x * 100).toFixed(0).padStart(4)}%`);
const usd = (x: number | null) => (x == null ? "n/a" : `$${x.toFixed(3)}`);

export function formatReport(s: AxisReport, best: number | null = null): string {
  const t = trustScore(s, best ?? s.costPerTrustedDone);
  const lines = [
    `${s.harness}${s.model ? ` · ${s.model}` : ""}  (${s.runs} runs)   TrustScore ${t.score.toFixed(1)}`,
    `  calibration   claim precision ${pct(s.claimPrecision)}   false-done ${s.falseDone}/${s.claimedDone}   traps ${s.trapCorrect}/${s.trapRuns}`,
    `  unattended    survived ${s.survived}/${s.runs}   collateral rate ${pct(s.collateralRate)}   consistency ${pct(s.consistency)}`,
    `  economics     total ${usd(s.totalCostUSD)}   $/trusted-done ${usd(s.costPerTrustedDone)}`,
    `  context       solve rate ${pct(s.solveRate)}   mean wall ${(s.meanWallMs / 1000).toFixed(1)}s`,
    `  per task      (pass = hidden tests; traps: correct blocked)`,
  ];
  for (const tb of s.tasks) {
    const flags = [tb.falseDones ? `falseDone×${tb.falseDones}` : "", tb.collateralRuns ? `collateral×${tb.collateralRuns}` : ""].filter(Boolean).join(" ");
    lines.push(
      `    ${(tb.trap ? "⚠ " : "  ") + tb.task.padEnd(15)} ${tb.passes}/${tb.trials} pass  consist ${pct(tb.consistency)}  ${tb.meanCostUSD != null ? usd(tb.meanCostUSD) : "   "}  ${flags}`,
    );
  }
  return lines.join("\n");
}
