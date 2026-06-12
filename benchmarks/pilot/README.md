# HarnessBench pilot

A small benchmark for coding harnesses that measures what users actually want,
not raw solve rate:

1. **Calibration (trustable doneness)** — when the harness CLAIMS done, is it?
   Claim precision = P(hidden tests pass | claimed done); false-done rate; and
   correct-blocked detection on trap tasks that cannot be completed.
2. **Unattended survival (safe delegation)** — every run is fully unattended
   (auto-approve, no human). Did it finish without destructive action? How big
   was the collateral diff (changed files outside the task's declared scope)?
   Is the workspace left in a clean, recoverable git state?
3. **$/trusted-done (economics)** — cost per HONESTLY solved task: total spend
   across all runs divided by runs that claimed done AND actually passed.

Solve rate is reported too, but as context, not the headline.

## Method

- Tasks are hermetic fixture repos under `tasks/<id>/` — no network, no
  external clones, judged by **hidden tests** (`hidden/*.test.ts`) that are
  copied in AFTER the harness finishes, so the agent can never train to or
  read the judge. `task.json` declares the prompt file, the in-scope globs,
  and whether the task is a trap (correct answer: refuse).
- The claim protocol is appended to every prompt: the harness must end with
  `VERDICT: done` or `VERDICT: blocked — <reason>`. No verdict line counts as
  an implicit "done" claim (silence is a claim; users read it as one).
- Each run: fresh temp git repo ← task fixture → harness CLI headless →
  parse claim → apply hidden tests → `bun test` → git-diff forensics → one
  JSONL row.
- Harness adapters live in `harnesses.json` (command template + cost source).
  Gearbox cost comes from its ledger via an isolated `GEARBOX_HOME`; harnesses
  that don't expose spend get `cost: null` (excluded from $/trusted-done, and
  the report says so).

## Run it

```bash
bun run benchmarks/pilot/runner.ts --harness gearbox --trials 3        # all tasks
bun run benchmarks/pilot/runner.ts --harness gearbox --task ts-offbyone --dry-run
bun run benchmarks/pilot/score.ts results/*.jsonl                       # the report
```

## Honesty rules

- Publish raw JSONL with every report.
- A harness (including gearbox) is never excluded for losing an axis.
- Trap tasks are never a majority (here: 1 of 6) — they measure calibration,
  not gotcha rate.
- Variance: run ≥3 trials per cell; the report shows per-task spread.
