// ── BENCHMARK CORPUS (real, researched, provenance-tagged) ───────────────────
// The data foundation for quality-aware routing. The router's quality bar is
// only as good as the numbers it compares against, and those numbers used to be
// ~90% hand-typed guesses (profiles.ts `src: "seeded"`). This module replaces
// the guess with REAL published benchmark scores, gathered from the live
// leaderboards (June 2026) with a source URL per number, refreshable via
// scripts/refresh-benchmarks.ts.
//
// Why MULTIPLE benchmarks per model (not one scalar): a single SWE-bench number
// can't route both a debug task and an architecture task. Quality is read
// PER TASK-KIND from the benchmarks that actually predict that kind:
//   code  → SWE-bench Verified + Aider Polyglot + LiveCodeBench (real-world coding)
//   plan  → GPQA Diamond + SWE-bench Verified (hard reasoning, coding as proxy)
//   chat  → GPQA Diamond, else the Artificial-Analysis intelligence composite
// The cheap kinds (search/classify/summarize) have a ~0 bar, so quality barely
// matters there and the lenient chat blend is reused.
//
// Normalization: SWE/Aider/LiveCodeBench/GPQA are all "fraction of problems
// solved" — already 0..1, on the SAME scale the 0.7 code bar was designed
// against. The Artificial-Analysis Intelligence Index is a 0..~100 composite
// (frontier tops out near 61 in 2026), so it is used ONLY as a last-resort
// fallback and normalized by AA_INDEX_REF, never blended with the percentages.
//
// Unknown / long-tail models (no row here) return null, and the router falls
// back to profiles.ts, then family inference, then the measured flywheel — so
// "route across any model" degrades gracefully instead of going blind.

export type BenchProvenance = "researched" | "estimated";

// One model's scores. Every field optional: a model on some leaderboards and
// not others is the norm. Percentages are stored as 0..1 fractions; aaIndex is
// the raw 0..100 composite. `asOf` + `srcUrls` make every number auditable.
export interface BenchmarkRow {
  sweVerified?: number; // SWE-bench Verified, fraction solved
  sweProVerified?: number; // SWE-bench Pro, fraction solved (harder, sparser coverage)
  aiderPolyglot?: number; // Aider Polyglot pass rate, fraction
  liveCodeBench?: number; // LiveCodeBench pass@1, fraction
  gpqaDiamond?: number; // GPQA Diamond, fraction (hard science reasoning)
  aaIndex?: number; // Artificial Analysis Intelligence Index, 0..100 composite
  src: BenchProvenance;
  asOf: string; // YYYY-MM snapshot
  srcUrls: string[]; // leaderboard URLs the numbers were read from
}

// AA Intelligence Index value treated as "fully capable" (1.0) when normalized.
// The 2026 frontier (Opus 4.8) sits at 61.4, so 65 keeps the best models just
// under 1.0 and never lets a composite-only model fake a top-tier quality.
const AA_INDEX_REF = 65;

// Researched June 2026 from the live leaderboards (see scripts/refresh-benchmarks.ts
// and the per-row srcUrls). null/absent = not listed on a fetched leaderboard
// page — deliberately NOT guessed (a wrong quality number misroutes real work).
// Keyed by the SAME model id used in providers.ts / profiles.ts.
const BENCH_BENCHLM = "https://benchlm.ai/benchmarks/sweVerified";
const BENCH_AA = "https://benchlm.ai/benchmarks/artificialAnalysis";
const BENCH_GPQA = "https://benchlm.ai/benchmarks/gpqa";
const BENCH_LCB = "https://llm-stats.com/benchmarks/livecodebench";
const BENCH_VALS = "https://www.vals.ai/benchmarks/swebench";
const BENCH_MORPH_PRO = "https://www.morphllm.com/swe-bench-pro";
const BENCH_LLMSTATS_SWE = "https://llm-stats.com/benchmarks/swe-bench-verified";

export const BENCHMARKS: Record<string, BenchmarkRow> = {
  "claude-opus-4-8": {
    sweVerified: 0.886, gpqaDiamond: 0.936, aaIndex: 61.4,
    src: "researched", asOf: "2026-06", srcUrls: [BENCH_BENCHLM, BENCH_AA, BENCH_GPQA],
  },
  "claude-sonnet-4-6": {
    sweVerified: 0.796, gpqaDiamond: 0.899, aaIndex: 44.4,
    src: "researched", asOf: "2026-06", srcUrls: [BENCH_BENCHLM, BENCH_AA, BENCH_GPQA],
  },
  "claude-haiku-4-5": {
    // The headline correction: real SWE-bench Verified 0.733 CLEARS the 0.7 code
    // bar — the old seeded 0.38 guess wrongly excluded Haiku from all code work.
    sweVerified: 0.733, sweProVerified: 0.395,
    src: "researched", asOf: "2026-06", srcUrls: [BENCH_BENCHLM, BENCH_MORPH_PRO],
  },
  "gpt-5.5": {
    sweVerified: 0.826, gpqaDiamond: 0.936, aaIndex: 60.2,
    src: "researched", asOf: "2026-06", srcUrls: [BENCH_VALS, BENCH_AA, BENCH_GPQA],
  },
  "gemini-3.1-pro-preview": {
    sweVerified: 0.806, sweProVerified: 0.461, gpqaDiamond: 0.941, aaIndex: 57.2,
    src: "researched", asOf: "2026-06", srcUrls: [BENCH_LLMSTATS_SWE, BENCH_AA, "https://artificialanalysis.ai/evaluations/gpqa-diamond", BENCH_MORPH_PRO],
  },
  "gemini-3.5-flash": {
    sweVerified: 0.788, gpqaDiamond: 0.922, aaIndex: 55.3,
    src: "researched", asOf: "2026-06", srcUrls: [BENCH_VALS, BENCH_AA, BENCH_GPQA],
  },
  "gemini-3.1-flash-lite": {
    aaIndex: 33.5,
    src: "researched", asOf: "2026-06", srcUrls: [BENCH_AA],
  },
  "deepseek-v4-pro": {
    sweVerified: 0.736, liveCodeBench: 0.568, gpqaDiamond: 0.901, aaIndex: 51.5,
    src: "researched", asOf: "2026-06", srcUrls: [BENCH_BENCHLM, BENCH_LCB, BENCH_AA, BENCH_GPQA],
  },
  "deepseek-v4-flash": {
    sweVerified: 0.737, liveCodeBench: 0.552, gpqaDiamond: 0.881, aaIndex: 46.5,
    src: "researched", asOf: "2026-06", srcUrls: [BENCH_BENCHLM, BENCH_LCB, BENCH_AA, BENCH_GPQA],
  },
  "grok-4.3": {
    gpqaDiamond: 0.901, aaIndex: 53.2,
    src: "researched", asOf: "2026-06", srcUrls: [BENCH_AA, BENCH_GPQA],
  },
  "grok-4.1-fast": {
    aaIndex: 23.6,
    src: "researched", asOf: "2026-06", srcUrls: [BENCH_AA],
  },
  // Amazon Nova / Meta Llama (AWS Bedrock): low composite, no coding-leaderboard
  // coverage — the AA index is enough to keep them below the code/plan bar.
  "bedrock/amazon.nova-pro-v1:0": {
    aaIndex: 13.5, src: "researched", asOf: "2026-06", srcUrls: [BENCH_AA],
  },
  "bedrock/meta.llama4-maverick-17b-instruct-v1:0": {
    liveCodeBench: 0.434, aaIndex: 18.4, src: "researched", asOf: "2026-06", srcUrls: [BENCH_LCB, BENCH_AA],
  },
  "bedrock/meta.llama4-scout-17b-instruct-v1:0": {
    aaIndex: 13.5, src: "researched", asOf: "2026-06", srcUrls: [BENCH_AA],
  },
};

// Bedrock/Vertex deployments mirror a canonical model's quality (same weights,
// different host). Map the mirror id → the canonical benchmark key so a
// Bedrock-Sonnet candidate gets Sonnet's real scores instead of falling through.
const ALIAS: Record<string, string> = {
  "bedrock/anthropic.claude-sonnet-4-20250514-v1:0": "claude-sonnet-4-6",
  "bedrock/anthropic.claude-haiku-4-5-20251001-v1:0": "claude-haiku-4-5",
  "bedrock/anthropic.claude-opus-4-20250514-v1:0": "claude-opus-4-8",
  "vertex/gemini-3.1-pro-preview": "gemini-3.1-pro-preview",
  "vertex/gemini-3.5-flash": "gemini-3.5-flash",
  "vertex/gemini-3.1-flash-lite": "gemini-3.1-flash-lite",
};

export function benchmarkRow(modelId: string): BenchmarkRow | undefined {
  return BENCHMARKS[modelId] ?? BENCHMARKS[ALIAS[modelId] ?? ""];
}

type Kind = "code" | "search" | "summarize" | "classify" | "plan" | "chat";

// Per-kind quality signal, in PRIORITY order (not equal-weight averaged):
//   code → SWE-bench Verified is THE gold-standard agentic-coding benchmark, so
//     it is primary; the others (Aider, LiveCodeBench) only fill in when SWE is
//     absent. Averaging them in would let a competitive-programming score (LCB)
//     drag down a model that is strong at real-world PRs — exactly the kind of
//     misroute this corpus exists to prevent.
//   plan → hard reasoning: GPQA + SWE-bench (coding as a reasoning proxy), meaned.
//   chat/cheap → GPQA, else the normalized composite.
const KIND_PRIMARY: Record<Kind, (keyof BenchmarkRow)[]> = {
  code: ["sweVerified"],
  plan: ["gpqaDiamond", "sweVerified"],
  chat: ["gpqaDiamond"],
  summarize: ["gpqaDiamond"],
  classify: ["gpqaDiamond"],
  search: ["gpqaDiamond"],
};
// Coding fallbacks used ONLY when no primary is present (e.g. a model on the
// LiveCodeBench board but not SWE-bench).
const CODE_FALLBACK: (keyof BenchmarkRow)[] = ["aiderPolyglot", "liveCodeBench"];

const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
const present = (row: BenchmarkRow, keys: (keyof BenchmarkRow)[]): number[] =>
  keys.map((k) => row[k]).filter((v): v is number => typeof v === "number");

/**
 * Real-data quality for (model, kind) on a 0..1 scale, or null when the corpus
 * has nothing for this model (caller falls back to profiles → family → flywheel).
 * Uses the kind's PRIMARY benchmarks (meaned if several); for code, falls back to
 * the coding benchmarks, then to the normalized AA composite. Never mixes the
 * percentage scale with the composite — percentages are "fraction solved", the
 * composite is a relative index, so blending them would be meaningless.
 */
export function qualityForKind(modelId: string, kind: Kind): number | null {
  const row = benchmarkRow(modelId);
  if (!row) return null;
  const primary = present(row, KIND_PRIMARY[kind]);
  if (primary.length) return mean(primary);
  if (kind === "code") {
    const fb = present(row, CODE_FALLBACK);
    if (fb.length) return mean(fb);
  }
  if (typeof row.aaIndex === "number") return Math.max(0, Math.min(1, row.aaIndex / AA_INDEX_REF));
  return null;
}

/** Provenance + the contributing benchmarks for the /why scorecard, so a quality
 *  number is always auditable ("code 0.79 · SWE 0.80, Aider 0.78 · researched 2026-06"). */
export function qualityNote(modelId: string, kind: Kind): string | null {
  const row = benchmarkRow(modelId);
  if (!row) return null;
  let keys = KIND_PRIMARY[kind].filter((k) => typeof row[k] === "number");
  if (!keys.length && kind === "code") keys = CODE_FALLBACK.filter((k) => typeof row[k] === "number");
  const parts = keys.map((k) => `${BENCH_LABEL[k] ?? k} ${(row[k] as number).toFixed(2)}`);
  if (!parts.length && typeof row.aaIndex === "number") parts.push(`AA-index ${row.aaIndex}`);
  return parts.length ? `${parts.join(", ")} · ${row.src} ${row.asOf}` : null;
}

const BENCH_LABEL: Partial<Record<keyof BenchmarkRow, string>> = {
  sweVerified: "SWE", aiderPolyglot: "Aider", liveCodeBench: "LCB", gpqaDiamond: "GPQA",
};
