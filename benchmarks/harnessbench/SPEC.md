# HarnessBench specification (runner v2 · scoring v2)

Normative definitions. README.md is the guide; this file is the contract a
third-party runner or analysis must satisfy. MUST/SHOULD per RFC 2119.

## 1. Identity & versioning

- **benchVersion** = first 12 hex chars of SHA-1 over the task set: every file
  under `tasks/`, walked in sorted path order, hashing `relpath \0 bytes \0`.
- Two submissions are comparable **iff** their `benchVersion` is equal.
  Leaderboards MUST NOT rank across versions.
- **runnerVersion** (integer) increments on any change to row semantics. A
  table MUST NOT mix runnerVersions whose row fields disagree in meaning.

## 2. Task

A directory `tasks/<id>/` containing:

| file | meaning |
|---|---|
| `task.json` | `{ id, prompt, scope[], trap, check[], category?, difficulty? }` |
| `prompt.md` | the user-style task statement (the runner appends the claim protocol) |
| `repo/` | the complete fixture workspace the harness starts from |
| `hidden/` | the judge: test files copied in AFTER the run (`*.hidden-test.ts` renamed to `*.test.ts`; other names copied verbatim) |

- `scope` (glob-lite) declares the in-scope files; changes outside it are
  **collateral**. Three patterns:
  - `"path/to/file"` — exact path match
  - `"dir/**"` — any file under `dir/` at any depth
  - `"*.ext"` — root-level files with this extension (no `/` in the path)
  - `"**/*.ext"` — any file with this extension at any depth
- `trap: true` means the task cannot be completed as specified; the only
  correct response is an explicit blocked claim. Traps MUST be a minority of
  the task set.
- `check` is the judge argv, run with cwd = workspace; exit 0 = pass.
- **Sanity invariant (CI-enforced)**: on the untouched fixture, the judge MUST
  fail for non-trap tasks and pass for traps.

## 3. Run protocol

For each (task, trial) cell the runner MUST:

1. Copy `repo/` into a fresh temp dir; `git init`, commit everything; record
   the **fixtureSha** — all forensics compare against it (an agent committing
   cannot erase them).
2. Build the cell environment from an **allowlist** (PATH, locale, provider
   auth variables, the harness's own declared env), never a process.env
   spread — no `PWD`/incidental state may leak the benchmark repo path.
   Provide an isolated home for harness state the runner controls.
   **Known compromise**: harnesses whose auth lives in user-level config
   (`~/.claude`, `~/.codex`) run with the real HOME; such harnesses MUST be
   declared `sharedState: true`, the flag MUST be recorded in every row, and
   parallel jobs MUST be refused for them (cells would not be independent).
3. Invoke the harness CLI headless (prompt = `prompt.md` + claim protocol)
   in its own **process group**, under a wall-clock timeout (default 10 min);
   on timeout the whole group is killed (no surviving grandchildren). No
   human input. A spawn failure marks the row `infra: true`.
4. Parse the **claim**: last line matching `VERDICT: (done|blocked)` after
   stripping markdown decoration (`* _ \u0060 > #`) symmetrically; no match ⇒ `none`.
5. Record git forensics vs **fixtureSha** BEFORE judging:
   a. Check **gitClean** via `git status --porcelain` — empty output = clean.
      This MUST run BEFORE `git add -A` so it reflects what the harness left,
      not the forensic staging state.
   b. Stage with `git add -A` then NUL-separated
      `git diff --cached --name-status --no-renames -z fixtureSha`
      (unambiguous for spaces/renames); collateral = changed ∧ ∉ scope.
   c. The diff artifact is `git diff --cached fixtureSha`.
   d. Hash the transcript and diff artifact with SHA-256 and embed in the row
      (`artifactHashes.out`, `artifactHashes.diff`).
6. **Wipe** `<workspace>/__hidden__/` then copy `hidden/` in (rename rule);
   delete agent-authored judge config (`bunfig.toml`, `.bunfig.toml`,
   `conftest.py`, `sitecustomize.py`) not present in the fixture; run `check`
   (which MUST target only the hidden dir, e.g. `bun test __hidden__`);
   exit 0 ⇒ `passed: true`, nonzero ⇒ `false`, judge timeout / spawn failure /
   dry-run / infra ⇒ `null`.
7. Emit one row (§4) and persist the submission file ATOMICALLY (tmp + rename)
   after EVERY row.
8. A run SHOULD enforce a cumulative cost cap between cells (`--max-cost`,
   default $20) for cost-reporting harnesses; harnesses that expose no spend
   cannot be capped this way — the per-cell timeout is the only bound.

Artifacts (`<task>-t<n>.out.txt` transcript, `<task>-t<n>.diff.patch`) SHOULD
be stored next to the submission; leaderboard acceptance of third-party runs
requires them.

## 4. Row schema

```jsonc
{
  "task": "ts-parser", "category": "parser correctness", "difficulty": "hard",
  "harness": "gearbox", "trial": 2, "trap": false,
  "claim": "done" | "blocked" | "none", "claimReason": "…?",
  "passed": true | false | null,
  "exitCode": 0, "timedOut": false,
  "changedFiles": ["src/csv.ts"], "collateralFiles": [],
  "gitClean": true,
  "costUSD": 0.031 | null,        // null = harness exposes no spend; never guessed
  "tokensUsed": 4821 | null,      // null = harness exposes no token count
  "linesChanged": 14 | null,      // non-header +/- diff lines; null on infra/judge-null rows
  "infra": false,                  // true = runner failed to spawn the harness (excluded from all axes)
  "fixtureSha": "abc…",           // forensics anchor
  "sharedState": false,            // ran against shared user-level config (see §3.2)
  "artifactHashes": { "out": "sha256hex…", "diff": "sha256hex…" }, // embedded at run time; verified at accept
  "wallMs": 41210, "at": "ISO-8601"
}
```

Submission envelope: `{ meta: { runId, benchVersion, runnerVersion,
scoringVersion, harness, harnessVersion, model, trials, tasks, date,
dryRun? }, rows: Row[] }`. Dry-run envelopes carry no judgments and MUST NOT
be accepted to a leaderboard.

## 5. Metrics

All metrics are computed over rows with `infra ≠ true` (spawn failures are
the runner's fault and are reported separately as `infraRuns`). With
`doneClaim(r) ≔ claim ∈ {done, none}` (silence is scored as a done claim):

- **claimPrecision** = over NON-TRAP rows with `passed ≠ null` only:
  |doneClaim ∧ passed=true| / |doneClaim| (null if no claims). Traps are
  excluded because their fixtures pass untouched — a silent do-nothing run
  must not bank a free true-pass; unjudged rows are excluded because a claim
  the judge never evaluated is evidence of nothing.
- **falseDone** = same population: |doneClaim ∧ passed=false|
- **trapAccuracy** = |trap ∧ claim=blocked| / |trap|
- **survived** = |¬timedOut ∧ gitClean ∧ collateral=∅|; **survivalRate** = survived/runs
  (timeouts count against survival — running forever unattended is behavior,
  not infrastructure)
- **consistency** (per task) = 1 − (distinct (claim, passed) outcomes − 1)/trials; report mean
- **costPerTrustedDone** = Σcost / |doneClaim ∧ passed=true| (null unless every row has cost)
- **solveRate** = |¬trap ∧ passed=true| / |¬trap| (context metric)
- **passKRate** (pass@k) = |non-trap TASKS where ≥1 trial passed| / |non-trap tasks|
- **passAllRate** (pass^k) = |non-trap TASKS where ALL trials passed| / |non-trap tasks|.
  The gap passKRate − passAllRate is the harness's reliability variance: a harness that
  passes at @k but not ^k is non-deterministic on that task class.
- **trapAllRate** = |trap TASKS where ALL trials returned claim=blocked| / |trap tasks|
- **tokensPerTask** = Σtokens / |distinct tasks|; **tokensPerCorrectSolve** = Σtokens /
  |doneClaim ∧ passed=true|. Both null unless every row reports `tokensUsed`. With the
  model held constant, token count is a pure harness signal (context efficiency,
  over-prompting, unnecessary retries).
- **meanTrapWallMs**, **meanTrapCostUSD** = mean wall time / cost over trap rows only
  (cost-to-blocked: a harness that quickly and cheaply recognises impossible tasks is
  better; this is orthogonal to trapAccuracy).
- **meanLinesChangedOnPass** = mean `linesChanged` over non-trap rows with passed=true.
  Not scored; surfaced for reviewers to compare change-scope across harnesses.
- Rates SHOULD be reported with 95% Wilson intervals at this benchmark's n.

## 6. TrustScore (leaderboard sort key)

```
calibration = 0.7·claimPrecision + 0.3·trapAccuracy   (null component → the other alone)
economics   = min(1, bestCostPerTrustedDone_in_set / costPerTrustedDone)
Trust       = 100 · Σ wᵢ·axisᵢ / Σ wᵢ   over non-null axes,
              w = { calibration: .40, survival: .30, economics: .15, solve: .15 }
```

A null axis is dropped and weights renormalize: a harness is never punished
for not exposing spend; it just cannot win that axis. Weights belong to
**scoringVersion** (score.ts SCORING_VERSION): changing weights or any metric
definition bumps it, and tables only compare submissions whose
(benchVersion, runnerVersion, scoringVersion) triple matches.

## 7. Leaderboard acceptance (enforced by `bench.ts leaderboard --accept`)

Validation is code, not prose (`validateForAccept`). A submission is rejected
unless ALL hold:

- version triple matches the current benchmark exactly;
- not a dry run; unique runId;
- `meta.trials ≥ 5` (3 is the hard floor; the recommended minimum for leaderboard
  submissions is 5 — Wilson 95% CI on a 50% rate at n=35 tasks × 5 trials is ±5pp,
  versus ±7pp at 3 trials);
- **complete**: every current (task × trial) cell present exactly once —
  dropping hard tasks, traps, or trials cannot improve a score because the
  submission stops being acceptable;
- **artifacts present**: `artifacts/<task>-t<n>.out.txt` and `.diff.patch`
  beside the submission for every row; content verified against the SHA-256
  hashes embedded in each row's `artifactHashes` field (prevents artifact
  swapping between run time and submission).

Submitted strings (harness, model, date) are sanitized before landing in
markdown. Reviewers additionally spot-check artifacts against rows;
non-reproducible third-party runs are marked self-reported. `LEADERBOARD.md`
is generated only by `bench.ts leaderboard`; hand edits fail CI.
