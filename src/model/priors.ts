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
// pushing a winner UP barely moves (the bar already vouches for it). Nothing
// activates below MIN_N outcomes — four data points is opinion, not evidence.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface OutcomeCounts {
  passed: number; // verification green after this model's edits
  failed: number; // verification red
  undone: number; // the user reverted the turn (/undo) — the strongest negative
  unverified: number; // edits with no checks to prove them
}

interface PriorsFile {
  version: 1;
  repos: Record<string, Record<string, Record<string, OutcomeCounts>>>; // repo → kind → modelId
}

export type Outcome = keyof OutcomeCounts;

const MIN_N = 4; // verified outcomes before a prior speaks
const BASELINE = 0.8; // expected pass rate; deltas measure distance from this
const SCALE = 0.25;
const MIN_DELTA = -0.12; // enough to sink below a 0.7 bar from a 0.8 quality
const MAX_DELTA = 0.04;
// With strong evidence (≥ MAX_DELTA_N verified outcomes) a winner may be
// promoted far enough to cross a bar it sits just under (e.g. a 0.65-quality
// model earning its way over the 0.7 code bar in THIS repo). Below that, the
// old conservative cap holds: four-to-nine green turns are encouragement, not
// proof. Without this, the flywheel could only ever demote — a cheap model
// that passes every verification here was structurally barred forever.
const MAX_DELTA_STRONG = 0.12;
const MAX_DELTA_N = 10;

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
  const f = load();
  const repo = opts.repo ?? repoSlug();
  const byKind = (f.repos[repo] ??= {});
  const byModel = (byKind[opts.kind] ??= {});
  const c = (byModel[opts.modelId] ??= { passed: 0, failed: 0, undone: 0, unverified: 0 });
  c[opts.outcome] += 1;
  save(f);
  cache = { f, at: Date.now() };
}

export interface Prior {
  n: number; // verified outcomes (passed + failed + undone)
  passRate: number; // Laplace-smoothed
  delta: number; // quality adjustment, clamped [MIN_DELTA, MAX_DELTA]
}

/** The measured prior for (kind, model) in this repo, or null below MIN_N.
 *  An /undo counts as a failure with double weight — a human revert is the
 *  costliest outcome a turn can have. */
export function priorFor(kind: string, modelId: string, repo?: string): Prior | null {
  const c = cached().repos[repo ?? repoSlug()]?.[kind]?.[modelId];
  if (!c) return null;
  const fails = c.failed + 2 * c.undone;
  const n = c.passed + c.failed + c.undone;
  if (n < MIN_N) return null;
  const passRate = (c.passed + 1) / (c.passed + fails + 2);
  const maxUp = n >= MAX_DELTA_N ? MAX_DELTA_STRONG : MAX_DELTA;
  const delta = Math.max(MIN_DELTA, Math.min(maxUp, (passRate - BASELINE) * SCALE));
  return { n, passRate, delta };
}

/** Raw outcome counts for (kind, model) in this repo — the Beta-sufficient
 *  statistics behind priorFor. Exposed so the Thompson policy can sample
 *  Beta(passed+1, failed+2·undone+1) directly instead of using the clamped
 *  point estimate. Returns null when nothing is recorded yet (the caller
 *  decides how to treat a cold start). */
export function countsFor(kind: string, modelId: string, repo?: string): OutcomeCounts | null {
  return cached().repos[repo ?? repoSlug()]?.[kind]?.[modelId] ?? null;
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
