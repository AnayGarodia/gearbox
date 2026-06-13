// Per-repo routing priors — the flywheel's memory. Every edited turn already
// produces ground truth (the VERIFY gate: tests/types passed or failed; /undo
// is a human revert). Recording that outcome per (repo, task-kind, model)
// turns "cheapest model that clears the bar" from a seeded guess into a
// measured, repo-specific fact: a model that keeps failing verification HERE
// sinks below the bar HERE, and the escalation that rescued it (cheap failed →
// strong passed) is itself the shadow comparison, captured for free.
//
// The adjustment is deliberately conservative and asymmetric: pulling a
// persistent failer DOWN matters (it costs the user real failed turns);
// pushing a winner UP barely moves (the bar already vouches for it — quality
// above the bar is already proven by the benchmark, so a measured bonus only
// needs to break ties, never to promote). Nothing activates below MIN_N
// outcomes — a handful of data points is opinion, not evidence, and a too-low
// threshold turns routine /undo cleanups into a verdict ("punish early,
// reward never"). Hence MIN_N = 8 and undone weighted BELOW failed: an /undo
// often means the user changed their mind or cleaned up, while a red VERIFY is
// unambiguous machine evidence.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface OutcomeCounts {
  passed: number; // verification green after this model's edits
  failed: number; // verification red — unambiguous machine evidence
  undone: number; // the user reverted the turn (/undo) — negative, but weaker than failed
  unverified: number; // edits with no checks to prove them
}

interface PriorsFile {
  version: 1;
  repos: Record<string, Record<string, Record<string, OutcomeCounts>>>; // repo → kind → modelId
}

export type Outcome = keyof OutcomeCounts;

const MIN_N = 8; // verified outcomes before a prior speaks (fewer is opinion, not evidence)
const BASELINE = 0.8; // expected pass rate; deltas measure distance from this
const SCALE = 0.25;
const UNDO_WEIGHT = 0.5; // an /undo counts as half a failure — weaker evidence than a red VERIFY
// Asymmetric clamp, on purpose: MIN_DELTA is large enough to sink a persistent
// failer below a 0.7 bar from a 0.8 quality (the whole point of the flywheel),
// while MAX_DELTA barely moves — a model already above the bar needs no
// promotion, and a generous bonus would let a lucky streak outrank benchmarks.
const MIN_DELTA = -0.12; // enough to sink below a 0.7 bar from a 0.8 quality
const MAX_DELTA = 0.04;
// Decay: priors must track the CURRENT repo and the CURRENT model, not their
// whole history — a model that improved (or a repo whose tests changed) should
// be able to climb back out. When verified outcomes pass this cap, all counts
// are halved: the pass RATE is preserved at that moment, but every future
// outcome carries double the weight of the pre-cap ones, so old evidence
// fades geometrically. A halved prior (~20) stays well above MIN_N, so decay
// never silences a prior that had already earned a voice.
const DECAY_CAP = 40;

function home(): string {
  return process.env.GEARBOX_HOME || join(homedir(), ".gearbox");
}
const file = () => join(home(), "priors.json");

/** Same slug derivation as session.ts — one identity for "this repo". */
export function repoSlug(cwd = process.cwd()): string {
  return cwd.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root";
}

function load(): PriorsFile {
  try {
    const f = JSON.parse(readFileSync(file(), "utf8"));
    if (f && f.repos) return { version: 1, ...f };
  } catch { /* none yet */ }
  return { version: 1, repos: {} };
}

function save(f: PriorsFile): void {
  try {
    mkdirSync(home(), { recursive: true });
    writeFileSync(`${file()}.tmp`, JSON.stringify(f, null, 2), { mode: 0o600 });
    renameSync(`${file()}.tmp`, file());
  } catch { /* best-effort */ }
}

let cache: { f: PriorsFile; at: number } | null = null;
const TTL = 10_000;

function cached(): PriorsFile {
  const now = Date.now();
  if (!cache || now - cache.at > TTL) cache = { f: load(), at: now };
  return cache.f;
}

export function recordTurnOutcome(opts: { kind: string; modelId: string; outcome: Outcome; repo?: string }): void {
  const f = cached();
  const repo = opts.repo ?? repoSlug();
  const byKind = (f.repos[repo] ??= {});
  const byModel = (byKind[opts.kind] ??= {});
  const c = (byModel[opts.modelId] ??= { passed: 0, failed: 0, undone: 0, unverified: 0 });
  c[opts.outcome] += 1;
  if (c.passed + c.failed + c.undone > DECAY_CAP) {
    c.passed = Math.round(c.passed / 2);
    c.failed = Math.round(c.failed / 2);
    c.undone = Math.round(c.undone / 2);
    c.unverified = Math.round(c.unverified / 2);
  }
  save(f);
  cache = { f, at: Date.now() };
}

export interface Prior {
  n: number; // verified outcomes (passed + failed + undone)
  passRate: number; // Laplace-smoothed
  delta: number; // quality adjustment, clamped [MIN_DELTA, MAX_DELTA]
}

/** The measured prior for (kind, model) in this repo, or null below MIN_N.
 *  An /undo counts as HALF a failure — a human revert is negative signal, but
 *  it is ambiguous (often the user changing direction or cleaning up), while a
 *  red VERIFY is unambiguous. Weighting undo below failed keeps routine
 *  cleanups from sinking a good model below the bar. */
export function priorFor(kind: string, modelId: string, repo?: string): Prior | null {
  const c = cached().repos[repo ?? repoSlug()]?.[kind]?.[modelId];
  if (!c) return null;
  const fails = c.failed + UNDO_WEIGHT * c.undone;
  const n = c.passed + c.failed + c.undone;
  if (n < MIN_N) return null;
  const passRate = (c.passed + 1) / (c.passed + fails + 2);
  const delta = Math.max(MIN_DELTA, Math.min(MAX_DELTA, (passRate - BASELINE) * SCALE));
  return { n, passRate, delta };
}

/** The measured failure rate for (kind, model) in this repo, or null below MIN_N.
 *  Purpose: converts the flywheel's measured outcomes into an EXPECTED-RETRY-COST
 *  signal for the scorer — a model that fails verification 30% of the time here
 *  is not cheap, each failure costs iterate-to-green re-runs. Same persisted
 *  counts and gating philosophy as priorFor: an /undo weighs half a failure,
 *  and fewer than MIN_N verified outcomes is opinion, not evidence. */
export function failRateFor(kind: string, modelId: string, cwd?: string): { rate: number; n: number } | null {
  const c = cached().repos[repoSlug(cwd)]?.[kind]?.[modelId];
  if (!c) return null;
  const n = c.passed + c.failed + c.undone;
  if (n < MIN_N) return null;
  const fails = c.failed + UNDO_WEIGHT * c.undone;
  const rate = fails / (c.passed + fails);
  return { rate, n };
}

/** Repo-wide (model-agnostic) failure rate for a kind: aggregates every model's
 *  outcomes for (repo, kind). Feeds the difficulty estimator — a repo where code
 *  tasks fail a lot is HARD, so the router should start stronger regardless of
 *  which model. Same gating + undo weighting as failRateFor. Null below MIN_N. */
export function repoFailRate(kind: string, cwd?: string): { rate: number; n: number } | null {
  const byModel = cached().repos[repoSlug(cwd)]?.[kind];
  if (!byModel) return null;
  let passed = 0, failed = 0, undone = 0;
  for (const c of Object.values(byModel)) { passed += c.passed; failed += c.failed; undone += c.undone; }
  const n = passed + failed + undone;
  if (n < MIN_N) return null;
  const fails = failed + UNDO_WEIGHT * undone;
  return { rate: fails / (passed + fails), n };
}

/** Human line for /why: "measured here: 7/9 ✓ (−0.04)". Null when no prior. */
export function priorLine(kind: string, modelId: string, repo?: string): string | null {
  const p = priorFor(kind, modelId, repo);
  if (!p) return null;
  const sign = p.delta >= 0 ? "+" : "−";
  return `measured here: ${Math.round(p.passRate * p.n)}/${p.n} ✓ (${sign}${Math.abs(p.delta).toFixed(2)})`;
}

/** Test hook. */
export function clearPriorsCache(): void {
  cache = null;
}
