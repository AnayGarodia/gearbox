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
  // Per-EFFORT outcomes (repo → kind → modelId → effort), so the flywheel can
  // learn "high effort was worth it HERE" and self-correct the modeled effort
  // curve (effort.ts). Separate tree so the per-model priors above are unaffected.
  effortOutcomes?: Record<string, Record<string, Record<string, Record<string, OutcomeCounts>>>>;
  // Per-AGENT outcomes (repo → agent → kind → modelId), so the flywheel learns
  // which model does best FOR A GIVEN ROLE here — e.g. @review on a cross-family
  // model, @explore on a cheap one. A separate tree, gated by the same MIN_N, so
  // it only overrides the kind-level prior once an agent has its own evidence.
  agentOutcomes?: Record<string, Record<string, Record<string, Record<string, OutcomeCounts>>>>;
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

let cache: { f: PriorsFile; at: number; path: string } | null = null;
const TTL = 10_000;

function cached(): PriorsFile {
  const now = Date.now();
  const path = file();
  // Reload when the TTL lapses OR the resolved priors PATH changed — the latter
  // keeps the in-memory cache from leaking one GEARBOX_HOME's priors into another
  // (a test sets a fresh home; without this the time-based cache would serve the
  // previous home's data and silently skew routing for ~10s).
  if (!cache || cache.path !== path || now - cache.at > TTL) cache = { f: load(), at: now, path };
  return cache.f;
}

const decay = (c: OutcomeCounts): void => {
  if (c.passed + c.failed + c.undone > DECAY_CAP) {
    c.passed = Math.round(c.passed / 2);
    c.failed = Math.round(c.failed / 2);
    c.undone = Math.round(c.undone / 2);
    c.unverified = Math.round(c.unverified / 2);
  }
};

export function recordTurnOutcome(opts: { kind: string; modelId: string; outcome: Outcome; repo?: string; effort?: string; agent?: string }): void {
  const f = cached();
  const repo = opts.repo ?? repoSlug();
  const byModel = ((f.repos[repo] ??= {})[opts.kind] ??= {});
  const c = (byModel[opts.modelId] ??= { passed: 0, failed: 0, undone: 0, unverified: 0 });
  c[opts.outcome] += 1;
  decay(c);
  // Per-effort tree (when the turn ran at a known effort): same counts, keyed by
  // effort, so effortPassRate can compare levels and self-correct the curve.
  if (opts.effort) {
    const byEffort = ((((f.effortOutcomes ??= {})[repo] ??= {})[opts.kind] ??= {})[opts.modelId] ??= {});
    const ec = (byEffort[opts.effort] ??= { passed: 0, failed: 0, undone: 0, unverified: 0 });
    ec[opts.outcome] += 1;
    decay(ec);
  }
  // Per-agent tree (when the turn ran AS an agent/role): same counts, keyed by
  // agent, so priorFor can prefer the model that does best for THIS role here.
  if (opts.agent) {
    const byAgent = ((((f.agentOutcomes ??= {})[repo] ??= {})[opts.agent] ??= {})[opts.kind] ??= {});
    const gc = (byAgent[opts.modelId] ??= { passed: 0, failed: 0, undone: 0, unverified: 0 });
    gc[opts.outcome] += 1;
    decay(gc);
  }
  save(f);
  cache = { f, at: Date.now(), path: file() };
}

/** Measured pass rate for (kind, model, effort) in this repo, or null below
 *  MIN_N verified outcomes. Lets effort.ts self-correct its modeled quality
 *  curve from real per-effort results once enough have accumulated. */
export function effortPassRate(kind: string, modelId: string, effort: string, repo?: string): { rate: number; n: number } | null {
  const c = cached().effortOutcomes?.[repo ?? repoSlug()]?.[kind]?.[modelId]?.[effort];
  if (!c) return null;
  const fails = c.failed + UNDO_WEIGHT * c.undone;
  const n = c.passed + c.failed + c.undone;
  if (n < MIN_N) return null;
  return { rate: (c.passed + 1) / (c.passed + fails + 2), n };
}

export interface Prior {
  n: number; // verified outcomes (passed + failed + undone)
  passRate: number; // Laplace-smoothed
  delta: number; // quality adjustment, clamped [MIN_DELTA, MAX_DELTA]
}

// Turn raw outcome counts into a gated Prior (null below MIN_N). One place so the
// per-(kind,model), per-agent, and any future tree all smooth + clamp identically.
function priorFromCounts(c: OutcomeCounts | undefined): Prior | null {
  if (!c) return null;
  const fails = c.failed + UNDO_WEIGHT * c.undone;
  const n = c.passed + c.failed + c.undone;
  if (n < MIN_N) return null;
  const passRate = (c.passed + 1) / (c.passed + fails + 2);
  const delta = Math.max(MIN_DELTA, Math.min(MAX_DELTA, (passRate - BASELINE) * SCALE));
  return { n, passRate, delta };
}

/** The measured prior for (kind, model) in this repo, or null below MIN_N.
 *  When `agent` is given and that agent has its OWN ≥MIN_N evidence for this
 *  (kind, model), the agent-specific prior wins — the flywheel has learned how
 *  this model does in this ROLE here, which is more specific than the kind-wide
 *  prior; otherwise it falls back to the kind-level prior.
 *  An /undo counts as HALF a failure — a human revert is negative signal, but
 *  it is ambiguous (often the user changing direction or cleaning up), while a
 *  red VERIFY is unambiguous. Weighting undo below failed keeps routine
 *  cleanups from sinking a good model below the bar. */
export function priorFor(kind: string, modelId: string, repo?: string, agent?: string): Prior | null {
  const r = repo ?? repoSlug();
  if (agent) {
    const ap = priorFromCounts(cached().agentOutcomes?.[r]?.[agent]?.[kind]?.[modelId]);
    if (ap) return ap; // agent-specific evidence is more specific — it wins once it reaches MIN_N
  }
  return priorFromCounts(cached().repos[r]?.[kind]?.[modelId]);
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

/** Human line for /why: "measured here: 7/9 ✓ (−0.04)". Null when no prior.
 *  Passes `agent` through so /why reflects the same prior routing actually used. */
export function priorLine(kind: string, modelId: string, repo?: string, agent?: string): string | null {
  const p = priorFor(kind, modelId, repo, agent);
  if (!p) return null;
  const sign = p.delta >= 0 ? "+" : "−";
  return `measured here: ${Math.round(p.passRate * p.n)}/${p.n} ✓ (${sign}${Math.abs(p.delta).toFixed(2)})`;
}

/** Test hook. */
export function clearPriorsCache(): void {
  cache = null;
}
