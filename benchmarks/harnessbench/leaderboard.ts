// Leaderboard: accepted submissions (leaderboard/*.json, committed via PR) →
// LEADERBOARD.md. Pure generation; the CLI lives in bench.ts.
//
// Comparability rule: a table only ever contains submissions whose
// benchVersion matches — older versions render in their own archived section.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Submission } from "./runner.ts";
import { scoreHarness, trustScore, wilson, type AxisReport } from "./score.ts";

export interface Entry {
  meta: Submission["meta"];
  report: AxisReport;
  file: string;
}

export function loadSubmissions(dir: string): Entry[] {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: Entry[] = [];
  for (const f of files.sort()) {
    try {
      const sub = JSON.parse(readFileSync(join(dir, f), "utf8")) as Submission;
      if (!sub?.meta?.benchVersion || !Array.isArray(sub.rows) || sub.rows.length === 0) continue;
      if (sub.meta.dryRun) continue; // plumbing runs carry no judgments
      out.push({ meta: sub.meta, report: scoreHarness(sub.rows, sub.meta.model), file: f });
    } catch {
      // a malformed submission never breaks the board; it is just absent
    }
  }
  return out;
}

const pct = (x: number | null) => (x == null ? "—" : `${(x * 100).toFixed(0)}%`);
const usd = (x: number | null) => (x == null ? "—" : `$${x.toFixed(3)}`);

/** Submitted strings land in committed markdown — neutralize table/HTML/link
 *  syntax and cap length so a hostile meta.harness can't inject content. */
export function sanitizeCell(s: string | null | undefined): string {
  if (!s) return "—";
  return s.replace(/[|\\<>\[\]`\n\r]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40) || "—";
}

/** 2-D grid: models as rows, harnesses as columns, TrustScore in each cell.
 *  Bold = best score in that row (best harness for this model).
 *  "—" = no submission for that (harness, model) pair. */
function grid(entries: Entry[], best: number | null): string {
  const harnesses = [...new Set(entries.map((e) => sanitizeCell(e.meta.harness)))].sort();
  const models = [...new Set(entries.map((e) => sanitizeCell(e.meta.model)))].sort();
  // index: "harness\0model" → {t, e}
  const idx = new Map<string, { score: number; e: Entry }>();
  for (const e of entries) {
    const key = `${sanitizeCell(e.meta.harness)}\0${sanitizeCell(e.meta.model)}`;
    const { score } = trustScore(e.report, best);
    const prev = idx.get(key);
    if (!prev || score > prev.score) idx.set(key, { score, e });
  }

  const header = `| Model | ${harnesses.join(" | ")} |`;
  const sep = `|---|${harnesses.map(() => "---").join("|")}|`;
  const dataRows = models.map((model) => {
    const scores = harnesses.map((h) => idx.get(`${h}\0${model}`)?.score ?? null);
    const rowBest = Math.max(...scores.filter((s): s is number => s != null));
    const cells = scores.map((s) =>
      s == null ? "—" : s === rowBest ? `**${s.toFixed(1)}**` : s.toFixed(1),
    );
    return `| ${model} | ${cells.join(" | ")} |`;
  });
  return [header, sep, ...dataRows].join("\n");
}

/** Flat ranked list with full axis detail — one row per (harness, model) combo. */
function detailTable(entries: Entry[], best: number | null): string {
  const ranked = entries
    .map((e) => ({ e, t: trustScore(e.report, best) }))
    .sort((a, b) => b.t.score - a.t.score);

  const rows = [
    "| # | Harness | Model | Trust | Calibration | Traps | Survival | $/trusted-done | Solve | pass^k | Tokens/solve | Date |",
    "|---|---------|-------|-------|-------------|-------|----------|----------------|-------|--------|-------------|------|",
  ];
  ranked.forEach(({ e, t }, i) => {
    const r = e.report;
    const w = wilson(r.truePass, r.claimedDone);
    const cal = r.claimPrecision == null ? "—"
      : `${pct(r.claimPrecision)} <sub>${w ? `${(w[0] * 100).toFixed(0)}–${(w[1] * 100).toFixed(0)}` : ""}</sub>`;
    const tok = r.tokensPerCorrectSolve == null ? "—"
      : r.tokensPerCorrectSolve >= 1_000_000 ? `${(r.tokensPerCorrectSolve / 1_000_000).toFixed(1)}M`
      : `${Math.round(r.tokensPerCorrectSolve / 1000)}k`;
    rows.push(
      `| ${i + 1} | ${sanitizeCell(e.meta.harness)} | ${sanitizeCell(e.meta.model)} | **${t.score.toFixed(1)}** | ${cal} | ${r.trapCorrect}/${r.trapRuns} | ${pct(r.survivalRate)} | ${usd(r.costPerTrustedDone)} | ${pct(r.solveRate)} | ${pct(r.passAllRate)} | ${tok} | ${sanitizeCell(e.meta.date).slice(0, 10)} |`,
    );
  });
  return rows.join("\n");
}

function renderVersion(es: Entry[]): string {
  if (!es.length) return "_No submissions yet for the current task set._";
  const costs = es.map((e) => e.report.costPerTrustedDone).filter((c): c is number => c != null && c > 0);
  const best = costs.length ? Math.min(...costs) : null;
  const lines: string[] = [];
  const harnesses = new Set(es.map((e) => sanitizeCell(e.meta.harness)));
  const models = new Set(es.map((e) => sanitizeCell(e.meta.model)));
  if (harnesses.size > 1 || models.size > 1) {
    lines.push(
      "TrustScore by model × harness (bold = best harness for that model).",
      "",
      grid(es, best),
      "",
      "---",
      "",
      "### Full axis breakdown",
      "",
    );
  }
  lines.push(detailTable(es, best));
  return lines.join("\n");
}

export function generateLeaderboard(entries: Entry[], currentBenchVersion: string): string {
  // Comparability key is the full version TRIPLE: task set + runner semantics
  // + scoring/weights. Any of the three changing archives the table.
  const verKey = (m: Submission["meta"]) => `${m.benchVersion} · r${m.runnerVersion}s${m.scoringVersion ?? 0}`;
  const byVersion = new Map<string, Entry[]>();
  for (const e of entries) byVersion.set(verKey(e.meta), [...(byVersion.get(verKey(e.meta)) ?? []), e]);

  const out: string[] = [
    "# HarnessBench leaderboard",
    "",
    "Generated by `bun run benchmarks/harnessbench/bench.ts leaderboard` — do not edit by hand.",
    "TrustScore = 40% calibration + 30% unattended survival + 15% economics (relative) + 15% solve rate;",
    "axes a submission cannot report are dropped with weights renormalized. See README.md for the method",
    "and the submission protocol. **Each cell is a (harness, model) pair** — model is not the variable,",
    "the harness is. Scores within the same model row are directly comparable.",
    "",
    `## Current task set \`${currentBenchVersion}\``,
    "",
  ];
  const currentEntry = [...byVersion.keys()].find((k) => k.startsWith(currentBenchVersion + " "));
  const current = (currentEntry ? byVersion.get(currentEntry) : byVersion.get(currentBenchVersion)) ?? [];
  out.push(renderVersion(current));

  for (const [v, es] of [...byVersion.entries()].filter(([v]) => !v.startsWith(currentBenchVersion))) {
    out.push("", `## Archived task set \`${v}\``, "", renderVersion(es));
  }
  out.push("");
  return out.join("\n");
}
