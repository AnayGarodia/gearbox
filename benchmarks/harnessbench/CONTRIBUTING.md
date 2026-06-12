# Contributing to HarnessBench

## Adding a task

Each task is a directory under `benchmarks/harnessbench/tasks/<id>/` containing four things:

```
tasks/<id>/
  task.json       metadata
  prompt.md       the user-facing task description (runner appends the claim protocol)
  repo/           the fixture workspace the harness starts from
  hidden/         judge files copied in AFTER the run
```

### `task.json` fields

| field | type | description |
|-------|------|-------------|
| `id` | string | must match the directory name |
| `prompt` | `"prompt.md"` | always this value |
| `scope` | string[] | glob patterns (exact path, `dir/**`, `*.ext`) — changes outside scope are collateral |
| `trap` | boolean | `true` = task is intentionally impossible; correct response is `VERDICT: blocked` |
| `check` | string[] | judge argv, run with cwd = workspace; exit 0 = pass |
| `category` | string | human label, e.g. `"bug fix"`, `"implement from spec"`, `"trap: missing spec"` |
| `difficulty` | string | `"easy"`, `"medium"`, or `"hard"` |

### Naming hidden test files

- TypeScript: name the file `*.hidden-test.ts`. The runner renames it to `*.test.ts` on copy.
- Python: name it `test_*.py` (standard pytest discovery); no renaming needed.
- Other languages: use whatever your `check` command discovers in `__hidden__/`.

### The sanity invariant (CI-enforced)

**Non-trap tasks**: the judge MUST fail on the untouched fixture. If the judge passes without any changes, it measures nothing.

**Trap tasks**: the judge MUST pass on the untouched fixture. Trap hidden tests verify the agent correctly refused — they check that the code was not destructively "solved" (i.e., the fixture state is unchanged or the corruption is detectable).

Run the sanity check locally before opening a PR:

```bash
bun run benchmarks/harnessbench/bench.ts doctor
```

This runs a dry-run pass over every task and verifies the invariant.

### Guidelines for good tasks

- **Realistic**: fixture code should look like something you'd encounter in a real codebase.
- **Unambiguous**: the prompt has exactly one correct interpretation. If a spec is ambiguous, make it a trap.
- **Narrow scope**: declare only the files the task actually requires. Tight scope tests collateral discipline.
- **Decisive judge**: the hidden tests should definitively distinguish a correct fix from a plausible-but-wrong attempt. Don't write judges that accept anything the harness might plausibly output.
- **Trap honesty**: a trap must be genuinely impossible as specified, not just hard. The model should be able to articulate WHY it's blocked. Examples: contradictory requirements, a missing spec file, a mathematically impossible performance bound.
- **Difficulty calibration**: easy tasks should be solvable in one focused edit; medium tasks require some reasoning; hard tasks require correctly handling multiple interacting edge cases.

### Task categories in use

| category | description |
|----------|-------------|
| `bug fix` | fix a known-wrong behavior |
| `implement from spec` | add a described feature from scratch |
| `behavior-preserving refactor` | restructure without changing observable behavior |
| `edge cases` | handle inputs the current code gets wrong |
| `multi-file fix` | a bug that requires edits across more than one file |
| `security fix` | fix a security vulnerability (e.g. path traversal) |
| `async correctness` | fix concurrency or Promise semantics |
| `parser correctness` | fix a grammar or parsing edge case |
| `scope discipline` | tasks designed to tempt unnecessary file changes |
| `trap: missing spec` | key spec file is absent |
| `trap: contradictory spec` | requirements contradict each other |
| `trap: conflicting constraints` | satisfying one constraint breaks another |

## Adding a harness

Edit `benchmarks/harnessbench/harnesses.json`. Each entry:

```jsonc
{
  "gearbox": {
    "command": ["gearbox", "-p", "{prompt}", "--yolo", "--model", "{model}"],
    "version": ["gearbox", "--version"],
    "env": { "GEARBOX_HOME": "{home}" },
    "cost": "gearbox-ledger"
  }
}
```

Fields:
- `command`: argv — `{prompt}` is replaced with the task prompt text, `{model}` with the `--model` flag value, `{home}` with the isolated home dir the runner provides.
- `version`: argv to print the harness version (recorded in submission metadata).
- `env`: extra env vars merged into the allowlist env. Use `{home}` for an isolated config dir.
- `cost`: `"gearbox-ledger"` to read gearbox's `~/.gearbox/ledger.jsonl`; omit if the harness exposes no spend.
- `sharedState`: `true` if the harness stores auth in the real user home (`~/.claude`, `~/.codex`). These harnesses cannot be run with `--jobs > 1`.

## Submission protocol

1. Run `bench.ts run --harness <id> --trials 3 --model <model>` on your machine.
2. Collect the `results/<runId>/` directory (submission.json + artifacts).
3. Run `bench.ts leaderboard --accept results/<runId>/submission.json` to verify it passes SPEC §7.
4. Open a PR adding `submission.json` to `benchmarks/harnessbench/leaderboard/` and link to the full artifacts (GitHub release, gist, or S3).

Reviewers will spot-check transcripts against rows. Runs that cannot be independently reproduced are marked *self-reported* in the table.

## CI

`.github/workflows/harnessbench.yml` runs on every change to `benchmarks/harnessbench/`:

- Fixture sanity: every non-trap judge fails on the untouched fixture; every trap judge passes.
- Dry-run plumbing: `bench.ts run --dry-run` for each harness.
- Leaderboard consistency: `LEADERBOARD.md` must match the committed `leaderboard/*.json` files.
- Version integrity: accepted submissions must match the current `benchVersion`.
