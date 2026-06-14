# Bake-off (T2): does the routing engine match frontier quality at lower cost?

Method: each (task, model) runs THIS branch's gearbox one-shot
(`bun run src/cli.tsx -p <prompt> --model <model> --yolo --json`) with cwd set to
a fresh copy of a HarnessBench fixture repo. The hidden test (never in the repo
during the turn) is then copied into `__hidden__/` and run as the judge. Cost is
derived from token usage × published list price, consistently across seats and
metered models; the Azure DeepSeek column also spends real Azure credits.

Runner: `experiments/routing-bench/bakeoff.ts`. Raw: `bakeoff-results.local.json`.

## Pilot — 10 tasks × 5 models × 1 trial (2026-06-14)

Tasks (hard-weighted + 2 traps): ts-offbyone, ts-null-check, ts-debounce,
ts-event-emitter, ts-statemachine, ts-lru-cache, ts-parser, ts-async,
trap-blocked, trap-two-owners.

| model              | solve% | $/solved | avg latency |
|--------------------|--------|----------|-------------|
| claude-haiku-4-5   | 100%   | $0.0176  | 19s         |
| claude-sonnet-4-6  | 100%   | $0.0197  | 27s         |
| claude-opus-4-8    | 100%   | $0.0369  | 25s         |
| DeepSeek-V4-Pro    | 80%    | $0.0281  | 122s        |
| **auto (engine)**  | 100%   | $0.0235  | 25s         |

## Findings

1. **Quality parity at the frontier.** `auto` matches the strongest model
   (100% solve) on this distribution. No correctness regression from routing.

2. **`auto` routed to the opus *seat* on every task — because a Claude Max
   subscription seat is $0 marginal, not because of no-net caution.** This is the
   key correction to a first read. Seats exist for haiku, sonnet AND opus (all
   `subscriptionSeats()`, all $0 until the rate-limit window fills). With three
   free seats, the expected-cost scorer takes the highest-quality one — opus — for
   every task. The fixtures also have no net (`package.json` is `{name, private}`,
   so `detectProofTier`→`none`), but that's moot here: even under
   `verifierTier:"tests"` the probe still picks the opus seat, because $0-vs-$0
   ties break to quality. **So the pilot's "auto" column is opus-via-free-seat —
   real marginal cost ≈ $0, not the $0.0235 list-equivalent derived in the table.**

3. **For a Max-subscriber, this is the best possible outcome: frontier quality at
   ~$0.** `auto` gives opus on every task for zero marginal dollars until the 5h/
   weekly quota fills; as headroom shrinks the scarcity/quota-burn terms shift it
   toward cheaper seats, and on exhaustion it fails over to metered cheap-first.
   The pilot measured the fresh-quota regime (opus-seat, 100%, ~$0 real cost).

4. **The cheap model is fully capable on this distribution.** haiku solved 100% of
   the same 10 tasks — including the hard ones (ts-parser, ts-async, ts-lru-cache)
   and both traps. This matters for the **metered** regime (API-only users, or a
   subscriber past their quota window): the cheap-first mechanism is a verified
   unit test (`test/router.test.ts`) — with a metered Anthropic key,
   `verifierTier:"tests"` → haiku, `verifierTier:"none"` → opus. So when you're
   actually paying per token, a verifier net buys haiku (proven capable here) at
   ~48% of opus's $/solved, with no measured quality loss on this distribution.

5. **Cross-vendor cheap is not a free lunch.** DeepSeek-V4-Pro is cheaper per
   token but: **5× slower** (122s vs ~25s avg), **token-hungry** in our agent loop
   (40–90k input vs the Claude seats' 2–7k), and weaker on the tail — 80% solve:
   it **timed out** on ts-parser (>240s, 0 tokens) and **failed a trap**
   (trap-two-owners — it edited instead of refusing). Latency is a real routing
   signal that should weight against it for interactive work.

6. **Judgment ≠ raw capability.** Every Claude tier (haiku→opus) and `auto`
   correctly refused both traps (blocked, two-owners). DeepSeek refused one and
   missed one. Refusal quality tracks model family, not price.

## What this does and does NOT let us conclude

- **Does**: routing preserves frontier quality (finding 1); with a Max seat `auto`
  delivers frontier quality at ~$0 marginal (2, 3); the cheap model is capable on
  this distribution (4); the metered cheap-first mechanism works (4, unit-tested);
  cross-vendor cheap has hidden latency/judgment costs (5, 6).
- **Does NOT**: empirically measure metered cheap-first end-to-end (the only
  metered account configured is azure-deepseek — a single model, no strong metered
  model to route *against*, and the seat dominates whenever a Max seat is present).
  It also can't find the **quality frontier** — the task ceiling is too low (haiku
  is 100%); differentiating haiku/sonnet/opus needs harder, multi-file,
  SWE-bench-grade tasks. And it can't calibrate `shipWrongUSD`: cost-of-wrong is
  undefined without a net, and the seat regime never exercises the no-net penalty.

## Next (to extend, each needs a setup choice)

- **Metered cheap-first, end-to-end.** Add a strong metered account (the
  aztea-aoai-sponsor GPT models) so the store has cheap (DeepSeek) *and* strong
  (GPT) metered options, add a real net (a visible spec test) to a task spread,
  and run with the CLI seats disabled. Then measure: (a) does `auto` drop to the
  cheap model under the net, (b) does it still pass the hidden judge, (c) the
  **false-cheap rate** — passing the weak visible net but failing the hidden judge.
  This is what calibrates the no-net penalty and proves the $ savings in the
  regime where dollars are actually spent.
- **Harder tasks** to locate the quality frontier (where the cheap model fails and
  the frontier earns its price) — real SWE-bench-grade, multi-file instances.

---

# Real-benchmark arm: Aider polyglot (2026-06-14)

HarnessBench is synthetic, single-file, net-free, and too easy (haiku 100%). The
**Aider polyglot benchmark** is the 225 *hardest* Exercism exercises (C++/Go/Java/
JS/Python/Rust) — real, multi-language, genuinely hard (GPT-4 couldn't one-shot
them). Runner: `polyglot.ts` (clones into `vendor/`, gitignored). Per (exercise,
model): copy the exercise WITHOUT `.meta/` (the reference solution lives there),
run gearbox `-p` to fill the solution file, RESTORE every non-solution file from
pristine (anti-cheat — a model can't pass by editing tests), run the language test
command. Validity guards: skip exercises whose stub already passes; a failed model
call (rate-limit/crash → no JSON) is recorded as ⚠ERR, never counted as a solve.

**IMPORTANT — headless `-p` does NOT run the VERIFY gate.** It's a single
`runTask`/`runCliTask` (the agent can self-test via shell under `--yolo`, but
there's no forced iterate-to-green). So these numbers are ~raw agentic capability
on hard problems, not net-carried.

## Result so far (24 exercises: 12 Python + 12 Go, 1 trial)

| model | solve% (valid) | notes |
|-------|----------------|-------|
| DeepSeek-V4-Pro (metered) | **96% (22/23)** | 1 genuine miss (go/beer-song), 1 timeout. $0.8875 Azure. |
| haiku / sonnet / opus (seats) | — | **rate-limited mid-run; no usable data** (see below) |

So a **cheap metered model solves 96% of the hardest Exercism set** in raw agentic
one-shot. On this distribution the cheap model is strong; the cheap-vs-strong gap
(if any) is still unmeasured because the strong models were unavailable.

## Operational findings (these shape what's measurable)

1. **Subscription seats can't sustain benchmark-scale load.** ~50–70 heavy seat
   calls exhausted the Claude Max 5h window (`usage.json`: claude-cli utilization
   1.0, resets ~3.5h). The seats run collapsed after the first exercise — every
   later call returned in 2–4s with 0 tokens. This is also exactly why `auto`
   treats the seat as free-until-walled, then fails over to metered. **Scale
   benchmarking requires metered models; seats only allow small samples between
   resets.**
2. **Codex headless seat is broken in this env.** `codex exec --json …` (and even
   `codex --version`) hangs on startup (node shim, exit 137, no output), with rare
   intermittent successes. gearbox reports "codex finished without an assistant
   message" (`cli-backend.ts:615`). A codex-install/env issue, not a routing bug —
   but it means the codex seat can't currently serve as a strong-model column.
3. **Harness validity matters.** `go/counter`'s stub already passes its own test,
   so a failed (0-token) call falsely scored "solved" until the stub-fails
   precondition + ERR guard were added. Always exclude no-work passes and
   infra-errors from solve%.

## Blocked on the cheap-vs-strong comparison

To compare cheap vs strong on real problems I need a working strong model. All
three are currently unavailable: opus seat (walled ~3.5h), codex gpt-5.5 (broken),
and there is no strong *metered* model configured. Resolution options are a
direction call (wait for reset / add Azure GPT sponsor / DeepSeek-only) — pending.

---

## Spend (this bake-off, exact)

Derived from token usage × list price; Claude seats are $0 marginal (subscription
quota), DeepSeek is real Azure credit.

- **Azure DeepSeek-V4-Pro**: **~$1.28** of credits total (derived; exact figure on
  the Azure portal). HarnessBench arm ~$0.39 (broken-judge runs ~$0.10, validation
  $0.05, killed-run partial $0.01, the 10-task pilot $0.2248). Polyglot arm
  **$0.8875** (24 hard exercises).
- **Claude (haiku/sonnet/opus seats + auto)**: **$0 marginal** (Max subscription
  quota). List-price equivalent consumed ≈ $0.98 across all runs.
- **Codex / OpenAI**: not used.
- **Total real money: ~$0.39** of the $100 Azure budget.
