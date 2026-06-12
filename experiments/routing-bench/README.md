# routing-bench — comparative routing-policy experiment

Measures 8 novel routing policies + 4 anchors on **Cost · Speed · Quality**, live,
against the existing router. Quality is a **hidden judge test the agent never
sees**; cost is the full ledger delta (turn + classifier + cascade aux calls);
speed is wall-clock to a verified turn including fix loops. Closes the gap in
`experiments/FINDINGS.md` Experiment 2 (which measured the scoring *algorithm*
on assumed priors, not real outcomes). Full write-up: **FINDINGS.md Experiment 8.**

## Policies (all behind `GEARBOX_ROUTER=<name>` / `--router <name>`)

| name | idea |
|---|---|
| `baseline` | today's `RoutingSelector` (classify → bar → cheapest winner) |
| `expected-cost` | cheap-first when `c_cheap + p_fail·(fix+c_strong) < c_strong` **and** a verifier exists; bar raised when none |
| `precedent` | kNN over this repo's verified outcome history (BM25 term similarity) |
| `thompson` | verifier-gated exploration: probe a cheaper tier at ε = 0.15/0.05/0 (tests/types/none) |
| `fix-routing` | route the FIX by failure kind — typecheck→down, test→top tier |
| `observables` | difficulty from BM25 retrieval spread; no classifier call |
| `selfverify` | AutoMix-style cheap self-check cascade (no-verifier repos) |
| `draft-review` | cheap draft → strong model reviews the diff |
| `combined` | the stack (observables + expected-cost + precedent + thompson + fix-routing) |
| `fixed-strong` / `fixed-cheap` / `random` | anchors (quality ceiling / cost floor / sanity) |

## How to run

```bash
# fixture corpus (30 graded TS+Py tasks, hidden judge per task)
bun run experiments/routing-bench/run.ts --cap 18 --out experiments/routing-bench/results/main
bun run experiments/routing-bench/analyze.ts experiments/routing-bench/results/main   # → RESULTS.md

# SWE-bench-Lite Django slice (no docker; FAIL_TO_PASS judged on a py3.12 venv)
bun run experiments/routing-bench/run-swe.ts --policies baseline,fix-routing,observables,combined,fixed-strong,fixed-cheap --cap 10 --out experiments/routing-bench/results/swe

# plumbing dry-run, zero spend
bun run experiments/routing-bench/run.ts --mock --out experiments/routing-bench/results/mock
```

Both runners are **resumable** (re-launch into the same `--out`; done pairs skip,
their spend counts toward the cap) and **budget-capped** (`--cap <USD>`, hard stop,
no silent truncation). Each policy gets an isolated `GEARBOX_HOME` so its
priors/precedent flywheel accumulates within the policy but never cross-contaminates.
`results/` is gitignored (transient workspaces + per-policy homes + Django checkouts).

## Headline results (Anthropic pool: haiku/sonnet/opus · 360 fixture runs $15.45 · 30 SWE runs $5.58)

| policy | fixture quality | fixture cost/task | vs baseline |
|---|---|---|---|
| observables | 90% | $0.038 | +3pp quality, +8% cost · matches the opus ceiling 25% cheaper |
| combined | 90% | $0.039 | +3pp, +9% · best on tests-tier repos (92% @ $0.026) |
| **fix-routing** ★ | 87% | $0.029 | =quality, **−19% cost** · #1 on hard + untested tasks |
| baseline | 87% | $0.036 | — |
| thompson ★ | 83% | $0.026 | −3pp, **−28% cost** (cold-start exploration tax) |
| **fixed-cheap** | **80%** | **$0.084** | **−7pp AND +135% cost — the false economy** |

★ = cost-quality Pareto frontier.

**The result that drives the recommendation:** "always pick the cheapest model"
(`fixed-cheap`) is **both the lowest quality and the most expensive policy** —
cheap models fail, thrash through fix loops, and still miss (44% on hard tasks).
Cheap-first only pays off *with* a verifier and smart escalation. The SWE slice
reproduced it on a real Django patch (fixed-cheap was the lone failure on an
otherwise-easy issue, at 4× the cost of the policy that passed).

**Recommendation:** ship `fix-routing` as the default (strict win over baseline:
same quality, −19% cost, wins the hard/untested cases), and fold in the
verifier-tier signal (aggressive cheap-first where a test gate exists, cautious
where none does). Do not ship blind cheap-first. `thompson`/`precedent` are
longitudinal bets (flywheel payoff over a repo's lifetime, not measurable in one
single-pass run). The cascade drivers (`selfverify`/`draft-review`) lost as built —
a same-tier self-judge doesn't discriminate. Caveats and negatives in FINDINGS.md.

## Files

- `tasks-ts.ts` / `tasks-py.ts` — the fixture corpus (prompt + seed files + hidden judge)
- `run.ts` — fixture runner (workspace → `gearbox -p --verify --router` → hidden judge → ledger delta)
- `run-swe.ts` — SWE-bench-Lite Django slice runner
- `analyze.ts` — rows.jsonl → RESULTS.md (per-policy + tier + verifier-visibility splits, Pareto frontier)
- `types.ts` — shared shapes
