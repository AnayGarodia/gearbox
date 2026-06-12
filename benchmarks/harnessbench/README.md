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
bun run benchmarks/harnessbench/bench.ts doctor                      # harnesses + judge toolchains + task-set version
bun run benchmarks/harnessbench/bench.ts run --harness gearbox --trials 3 --model auto --jobs 4
bun run benchmarks/harnessbench/bench.ts run --harness gearbox --resume <runId>   # fill a crashed run's missing cells
bun run benchmarks/harnessbench/bench.ts score results/<runId>/submission.json
bun run benchmarks/harnessbench/bench.ts leaderboard --accept results/<runId>/submission.json
```

`--jobs N` runs cells concurrently — refused for harnesses marked
`sharedState` (claude/codex/opencode authenticate via their user-level config,
which the runner cannot isolate; parallel cells racing one config dir are not
independent samples). `--resume <runId>` continues a crashed run and must
match its harness/trials/dry-run flags and task set. `--max-cost <usd>`
(default 20) aborts between cells once cumulative reported spend exceeds the
cap — only enforceable for cost-reporting harnesses; the per-cell timeout is
the only bound for the rest. SPEC.md is the formal contract (schema, metric
definitions, acceptance rules); this README is the guide.

`run` prints the full report at the end and writes a self-contained
**submission** (`results/<runId>/submission.json`: metadata + every row) plus
per-run **artifacts** (`artifacts/<task>-t<n>.out.txt` transcript and
`.diff.patch`) — the audit trail a leaderboard entry rides on. The submission
file is persisted after every row, so a crashed run keeps what finished.

## Method

- **Tasks** are hermetic fixture repos under `tasks/<id>/` — no network, no
  clones. Each declares its prompt, in-scope globs, category, difficulty
  (easy/medium/hard), and whether it is a trap. 20 tasks across TypeScript and
  Python spanning: bug fixes (null handling, array mutation, off-by-one,
  mutable default, state machine), implement-from-spec (event emitter,
  slugify, duration parser), behavior-pinned refactor, unicode edge cases,
  scope discipline, multi-file fix, security (path traversal), parser
  correctness (RFC 4180 CSV), async correctness (in-flight memoization and
  deep clone), sorting tie-breaks, and three traps (missing spec;
  self-contradictory requirements; conflicting change constraints).
- **Hidden tests** (`hidden/*.hidden-test.ts`) are copied in AFTER the harness
  finishes, so the agent can never read the judge. CI proves every non-trap
  judge FAILS on the untouched fixture (a gate that can't fail measures
  nothing) and that traps pass when left alone.
- **Claim protocol**: every prompt ends with an instruction to print
  `VERDICT: done` or `VERDICT: blocked — <reason>` as the final line. Silence
  is scored as a done claim — that is how users read it.
- **Isolation**: each run gets a fresh temp git repo, an allowlist
  environment (no PWD leak of the benchmark repo; provider auth passes
  through), its own process group (timeouts kill grandchildren too), and an
  isolated home where the runner controls it. HONEST CAVEAT: sharedState
  harnesses (claude/codex/opencode) keep their real HOME because their login
  lives there — their global config/memory rides along, the rows record the
  flag, and cross-harness comparisons should mention it.
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
  enforces SPEC §7 in code: version triple match, not a dry run, ≥3 trials,
  COMPLETE coverage of every (task × trial) cell (omission can't game a
  score), artifacts present for every row, no duplicate runIds, and submitted
  strings sanitized against markdown injection.
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
- Traps are never a majority (2 of 14) — they measure calibration, not gotchas.
- ≥3 trials per cell for any published table; the report shows per-task spread
  and 95% Wilson intervals on every rate — at this n, the interval IS the result.
- Weights and task set never change silently: any change → new benchVersion →
  new table.

## CI guardrails

`.github/workflows/harnessbench.yml` (benchmark paths only, no paid calls):
fixture sanity (every non-trap judge fails untouched; traps pass), runner
dry-run plumbing, LEADERBOARD.md must match committed submissions, and every
accepted submission must match the current task-set version.

## Adding tasks or harnesses

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full task authoring guide (fixture layout,
hidden test naming, the sanity invariant, trap design guidelines) and the harness
configuration reference.

## Known limits (v2)

- Tasks are small (TS + Python); they measure trust properties, not
  large-codebase navigation. Adding languages only requires the fixture +
  hidden tests — the runner is language-agnostic via `task.check`.
- Cost capture beyond gearbox needs per-harness adapters (most CLIs don't
  expose spend); until then those cells show `n/a`.
- Model choice inside a harness is the submitter's configuration, recorded as
  `--model` metadata, not enforced.
