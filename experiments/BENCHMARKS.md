# Benchmark & evaluation plan

Goal: make the routing claim a number people can cite —
**"same tasks, equal pass rate, X% of the cost of a pinned frontier model"** —
with a method anyone can rerun.

## The claim to test

H1: RoutingSelector achieves a VERIFY pass rate within a small margin (≤3pp)
of pinned `claude-opus-4-8` while spending materially less (target ≥50% cost
reduction), on real coding tasks across repos.

H2: per-repo priors improve routing over time: pass-rate and cost on the second
half of a task sequence beat the first half (the flywheel actually turns).

## Harness design

Three layers, cheapest first:

### L1 — Routing replay (offline, free, runs in CI)
Replay recorded turn fixtures (prompt, kind, account state) through
RoutingSelector and assert pick stability, cost monotonicity, and prior
sensitivity. This already fits the existing fixture-test style (scoring.ts is
pure). Guards regressions; proves nothing about quality.

### L2 — Task suite with VERIFY as judge (the core number)
- Tasks: 30–50 self-contained issues across 5–8 public repos (TS, Python, Go)
  with real test suites: bug fixes, small features, refactors. Selection rule:
  the repo's own tests must be able to FAIL the task (VERIFY is the judge, so
  the gate must be real). Store as JSONL: {repo, sha, prompt, check_cmd}.
- Arms: (a) routed, (b) pinned opus, (c) pinned cheap (haiku/deepseek) as the
  floor, (d) routed-with-warm-priors (after a seed pass) for H2.
- Runner: `gearbox -p` headless with --yolo in a throwaway container per task
  (the OS sandbox stays on: seatbelt on macOS, bwrap on Linux where installed — the container is the hard isolation boundary); capture VERIFY tier + pass/fail,
  ledger cost, wall time, hops. One JSON row per (task, arm, trial); ≥3 trials
  per cell (models are stochastic).
- Metrics: pass rate, $/solved-task (cost divided by passes — the honest
  headline), p50 wall time, hop rate.

### L3 — Public anchor (credibility)
Run SWE-bench Lite (or Verified subset, budget allowing) and Terminal-Bench
with the same arms, mainly so outsiders can place the harness on known
leaderboards. Expensive; run once per release, not in CI.

## Infrastructure notes

- The ledger (`ledger.jsonl`) is already the cost source of truth — the runner
  just reads it per task; no new metering needed.
- Headless mode currently restricts writes without --yolo; the runner uses
  --yolo inside containers, which is also the honest configuration (no human
  gates to confound timing).
- Priors isolation: each arm runs with its own GEARBOX_HOME so measured priors
  don't leak between arms; arm (d) seeds GEARBOX_HOME from a prior pass.
- Publish: methodology + task list + raw JSONL + a small report in
  experiments/; headline number goes in README with a link.

## Order of work

1. L1 replay fixtures (small, immediate CI value).
2. Task-suite format + 10-task pilot on this repo + 2 externals; debug the
   runner end to end.
3. Full L2 run, 3 trials; write up. 4. L3 anchor run per release.
