# HarnessBench

A benchmark for coding harnesses that measures what users actually want from
an agent, not raw solve rate:

1. **Calibration (trustable doneness)** — when the harness claims done, is it?
   Claim precision = P(hidden tests pass | claimed done), false-done rate, and
   trap detection (tasks whose only correct answer is to refuse).
2. **Unattended survival (safe delegation)** — every run is fully unattended
   (auto-approve, no human). No timeouts, recoverable git state, zero
   collateral (changed files outside the task's declared scope), and trial
   consistency (same task, same outcome).
3. **Economics** — $/trusted-done: cost per HONESTLY solved task.

Solve rate and wall time are reported as context, never the headline.

## Quick start

```bash
bun run benchmarks/harnessbench/bench.ts doctor                      # what can run here?
bun run benchmarks/harnessbench/bench.ts run --harness gearbox --trials 3 --model auto
bun run benchmarks/harnessbench/bench.ts score results/<runId>/submission.json
bun run benchmarks/harnessbench/bench.ts leaderboard --accept results/<runId>/submission.json
```

`run` prints the full report at the end and writes a self-contained
**submission** (`results/<runId>/submission.json`: metadata + every row) plus
per-run **artifacts** (`artifacts/<task>-t<n>.out.txt` transcript and
`.diff.patch`) — the audit trail a leaderboard entry rides on. The submission
file is persisted after every row, so a crashed run keeps what finished.

## Method

- **Tasks** are hermetic fixture repos under `tasks/<id>/` — no network, no
  clones. Each declares its prompt, in-scope globs, category, and whether it is
  a trap. 8 tasks: bug fix, implement-from-spec, behavior-pinned refactor,
  unicode edge cases, scope discipline, multi-file fix, and two traps (missing
  spec; self-contradictory requirements).
- **Hidden tests** (`hidden/*.hidden-test.ts`) are copied in AFTER the harness
  finishes, so the agent can never read the judge. CI proves every non-trap
  judge FAILS on the untouched fixture (a gate that can't fail measures
  nothing) and that traps pass when left alone.
- **Claim protocol**: every prompt ends with an instruction to print
  `VERDICT: done` or `VERDICT: blocked — <reason>` as the final line. Silence
  is scored as a done claim — that is how users read it.
- **Isolation**: each run gets a fresh temp git repo and its own empty home
  (no priors, memory, or spend leaking between runs or arms).
- **Cost**: gearbox spend is read from its ledger; harnesses that expose no
  spend report `n/a` and are simply unable to win the economics axis (weights
  renormalize — never punished, never guessed).

## Reading the report

```
gearbox · auto  (24 runs)   TrustScore 87.3
  calibration   claim precision  95%   false-done 1/21   traps 5/6
  unattended    survived 22/24   collateral rate   4%   consistency  88%
  economics     total $0.84   $/trusted-done $0.042
  context       solve rate  83%   mean wall 41.2s
  per task      …one line per task: passes/trials, consistency, mean cost, flags
```

**TrustScore** (the leaderboard sort key) = 40% calibration (0.7·precision +
0.3·trap accuracy) + 30% survival + 15% economics (relative: best
$/trusted-done in the comparison set = 1.0) + 15% solve. Axes a submission
cannot report are dropped and the weights renormalize. The per-axis profile
matters more than the order; the composite exists so a table can be sorted.

## Leaderboard maintenance

- Accepted submissions live in `leaderboard/*.json` (committed).
  `bench.ts leaderboard` regenerates `LEADERBOARD.md` from them; `--accept`
  validates and copies a submission in (current task set only, no duplicate
  runIds).
- **Versioning**: the benchmark version IS the task-set content hash
  (`taskSetHash()`); it is stamped into every submission. Tables only compare
  submissions with matching versions; editing any task automatically archives
  the old table rather than silently corrupting it.
- **Submission protocol** (for third parties): run `bench.ts run` on your
  machine, open a PR adding your `submission.json` to `leaderboard/` with a
  link to the full `results/<runId>/` artifacts (gist/release). Reviewers
  spot-check transcripts against rows. Self-reported runs are marked as such
  if reviewers cannot reproduce them.

## Honesty rules

- Raw rows + artifacts accompany every published number.
- No harness (including gearbox) is excluded or excused for losing an axis.
- Traps are never a majority (2 of 8) — they measure calibration, not gotchas.
- ≥3 trials per cell for any published table; the report shows per-task spread.
- Weights and task set never change silently: any change → new benchVersion →
  new table.

## Known limits (v2)

- Tasks are small and single-language (TS); they measure trust properties, not
  large-codebase navigation. Adding repos in other languages only requires the
  fixture + hidden tests — the runner is language-agnostic via `task.check`.
- Cost capture beyond gearbox needs per-harness adapters (most CLIs don't
  expose spend); until then those cells show `n/a`.
- Model choice inside a harness is the submitter's configuration, recorded as
  `--model` metadata, not enforced.
