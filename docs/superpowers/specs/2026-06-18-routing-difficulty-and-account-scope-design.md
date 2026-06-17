# Routing: difficulty-aware picks + active-account scoping

**Date:** 2026-06-18
**Status:** design, pending implementation

## Problem

Two observed routing failures, both reducing to "cheapest tiny model wins":

1. **Wrong model for a hard task.** A substantial code turn (implement clock-offset
   embedding, refactor event names) routed to `gpt-5.4-nano` — the weakest Azure
   tier. Cross-account it grabbed Anthropic Haiku (the globally cheapest model).
   The router cannot tell a one-line typo fix from a concurrency bug at turn-start.

2. **Active account ignored.** The user sat in the Azure account
   (`Azure AI Foundry · auto`) yet `$1.08` of spend landed on the Anthropic key.
   Being *displayed* as the active account does not scope routing.

### Root causes (verified in code)

**Difficulty blindness (failure 1).**
- The objective's quality term is `wrongCost = P(wrong) × cost-of-wrong`
  (`objective.ts`). For it to pull a hard task toward a strong model, `difficulty`
  must be high and `cost-of-wrong` non-trivial.
- `estimateDifficulty` (`difficulty.ts:69`) is built only from *size* signals
  (context tokens, touched-file count/bytes, repo fail-rate, centrality). For a
  bare interactive prompt with no `@file` mentions, `gatherDifficultySignals`
  (`router.ts:773`) sees an empty `touchedFiles` and modest `estTokens`, so
  `d ≈ 0`. The LLM classifier emits *kind* only, never difficulty.
- `wrongCostOf` zeroes the ship-wrong damage under a test net: `netFactor` is
  **0 for `verifierTier === "tests"`** (`objective.ts:176`), and the live scorer
  **defaults unknown tier to `"tests"`** (`scoring.ts:261`). So in any repo with
  tests (gearbox itself), cost-of-wrong collapses to a small per-Mtok recovery
  fee.
- Net: with `difficulty ≈ 0` and `shipWrong ≈ 0`, the objective reduces to
  cheapest-capable-wins.
- **Key gap:** `difficulty.ts` defines `DIFFICULTY_BAR_RANGE = 0.2` and documents
  difficulty as something "the router adds to the bar," but the floor at
  `router.ts:457` only adds the reactive `escalate` term — **predicted difficulty
  never reaches the hard floor.** It only feeds the soft term that tests disable.

**Account-scope semantics (failure 2).**
- Routing *does* honor a scope: `applyAvoid` (`router.ts:307`) filters candidates
  to `pol.pinAccount` when set, falling back to the full pool only if the pinned
  account can serve nothing for the task.
- But two concepts coexist: `activeAccount` (prefs — status-bar display, relaunch
  restore) and `pinAccount` (policy — the actual routing scope). The status bar
  renders `activeAccount`; only an explicit `/account use` sets `pinAccount`
  (`command-handler.ts:1786`). So the displayed account does not scope routing,
  and `· auto` is the only (cryptic) tell that routing is still global.

## Decisions

- Lead with **predicting difficulty up front** (chosen over reactive escalation or
  global re-tuning): give the router a semantic difficulty signal and a hard lever
  to receive it. Reactive escalation and per-repo priors remain the safety net.
- **Active account scopes routing.** Selecting/showing an account pins routing to
  it; an explicit "All accounts" mode is the only way to route across every
  account. One fewer concept, matches user expectation.
- Difficulty granularity: **three bands** (easy/medium/hard), not a 0–1 score.
- Difficulty judge latency: **bounded ~600ms blocking** on code/plan cache-miss,
  size-based fallback on timeout; cached per-prompt per-repo.
- **LLM = perception, engine = decision.** The small LLM only judges the task
  (kind + difficulty); the model+account pick stays pure deterministic arithmetic.
  The judge's output is a constrained judgment, never a free-form model id.
- **Cheapest-possible judge.** The perception call routes as a `classify`-kind turn
  (floor 0 → cheapest-capable-wins), so the cheapest available model falls out of
  the existing engine and stays account-scope-aware. No second model-selection path.

## Design

### Principle: LLM = perception, engine = decision

A small LLM is used for exactly one thing — *judging the task* (kind + difficulty,
the soft semantic read the math cannot compute from numbers). It never picks the
final model+account. The decision itself — filter by capability/usage/scope, then
`argmin(expected $)` — stays pure, deterministic arithmetic (`scoring.ts`,
`objective.ts`), because:

- routing *is* arithmetic (price × tokens, balance cover, rate-limit knees,
  context fit, argmin over ~25 candidates), and LLMs are unreliable at
  multi-number threshold logic;
- routing runs every turn — a deterministic pick is fixture-testable,
  reproducible, and explainable in `/why`; an LLM pick is none of those;
- live state (balances, rate headroom, prices, per-repo priors) lives in typed
  structures the engine reads directly, not serialized into a prompt that goes
  stale.

The LLM's output is constrained to a judgment (`difficulty: easy|medium|hard`) or
at most a coarse tier — **never** a free-form model id (which it would
hallucinate). The engine maps that judgment → concrete model under live
constraints. This boundary is the design's load-bearing decision; do not let the
judge creep toward picking models.

### Cheapest-possible judge: route it as a `classify` turn

The perception call must use the cheapest available model, and it should fall out
of the existing engine rather than a second hardcoded model selection. The judge
runs as a routed turn of kind `classify` (or `summarize`), which already has
`CAPABILITY_FLOOR = 0` (`router.ts:73`) — so cheapest-capable-wins selects the
globally cheapest model on its own, and it stays **account-scope-aware** (honors
Fix B: a judge call inside the Azure scope picks the cheapest Azure model, not a
stray Anthropic key). The only hard requirement on the candidate is that it can
return the constrained structured output; a model that fails calibration on the
bake-off set (below) is excluded so the floor drops to the next-cheapest. No new
model-selection code path — reuse the seam.

### Fix A — difficulty-aware routing

**A1. The signal (semantic difficulty).** Extend classification to emit a
difficulty band for code/plan turns, mirroring how *kind* is already classified
(two-tier, cached, graceful fallback). Lives alongside `classifyTask`
(`src/agent/classify.ts`).

- **Lexical fast-path** (instant, free): obvious-hard cues (`race condition`,
  `concurrency`, `deadlock`, `migration`, `refactor across`, `security`,
  `performance regression`, `rewrite`) → `hard`; obvious-trivial cues (`rename`,
  `typo`, `bump version`, `fix import`, `comment`) → `easy`. Returns null when
  uncertain.
- **Cheap LLM judge** for the uncertain remainder: returns
  `{ band: "easy"|"medium"|"hard", reason: string }`, on the cheapest available
  model (selected by routing the call as a `classify` turn — see "Cheapest-possible
  judge" above). Folded into the *same* call that classifies kind when that call
  runs (≈ zero marginal cost). For confident-keyword code turns where the kind
  classifier is skipped today, the judge runs with a ~600ms blocking budget and
  falls back to the current size-based `estimateDifficulty` on timeout. Cached
  per-prompt per-repo (`~/.gearbox/classify-cache.json` or a sibling), so repeats
  are free.
- **Band → score:** `easy → 0`, `medium → 0.4`, `hard → 0.85`.
- **Combine** with the existing size-based estimate:
  `semanticDifficulty` becomes a new `DifficultySignals` field; final
  `effDifficulty = max(semanticScore, sizeBasedD)`. `max` lets either signal flag
  hard, while an `easy` verdict on a small task stays 0 → cheap model still wins
  (cost-regression guard).

**A2. The wiring (the actual fix).** Add the difficulty term to the floor in
`prepare()` (`router.ts:457`), using the already-defined `DIFFICULTY_BAR_RANGE`:

```
floor = min(FLOOR_MAX,
            CAPABILITY_FLOOR[kind]
          + escalate · escalationFloorStep(failureKind)   // reactive (unchanged)
          + effDifficulty · DIFFICULTY_BAR_RANGE)          // NEW: proactive
```

A predicted-hard code turn lifts the floor by up to 0.2 at turn 1 — doing
proactively what a failed-check escalation does reactively, and composing with it
(both move the same floor, capped at `FLOOR_MAX`). Because the floor is
independent of the verifier net, this sidesteps the `shipWrong`-zeroed-under-tests
problem. Continue feeding `effDifficulty` into the soft objective
(`flags.difficulty`, `router.ts:583/617`) — it still helps in no-test-net repos.

**Why floor, not just the objective:** the floor is the hard, net-independent
lever escalation already uses; the soft objective is what tests neuter. Predicting
difficulty without a hard lever would do almost nothing in repos with tests.

### Fix B — active account scopes routing

Derive the routing scope from `activeAccount` unless an explicit "All accounts"
mode is on.

- Introduce an `allAccounts` mode (prefs flag, or a sentinel `activeAccount` value).
  When **off** (default) and `activeAccount` is set, the effective routing scope is
  that account: the router scopes candidates to it (reuse the existing
  `pinAccount` filter at `router.ts:307`, fed from the active account when no
  explicit pin is set). When **on**, routing spans all accounts.
- Keep the existing empty-scope fallback (`router.ts:310`): if the active account
  can serve nothing tools-capable for the task, fall back to the full pool so a
  turn is never blocked. Surface this in `/why` ("Azure can't serve a
  tools-capable model here — routed across all accounts").
- **Status bar** reflects the real scope: `Azure AI Foundry · auto` = scoped to
  Azure; `All accounts · auto` = global. The account zone is already clickable
  (`statusBarLayout`); clicking toggles scope / opens the account picker with an
  "All accounts" entry.
- **Subscription-seat nuance** (resolve in the plan): a subscription seat today
  uses `SubscriptionPinSelector` (bypasses routing) and `/account use` clears
  `pinAccount` (`command-handler.ts:1770`). Define active-account scoping for
  API-style accounts first (Azure/Anthropic/etc.); for an active subscription
  account, scope auto-routing to that account's seats + canonical models. Do not
  regress the existing hard seat-pin path.

## Scope boundaries (YAGNI)

- **Not** touching symptom "easy tasks not delegated" (no auto intra-turn
  delegation). That is a separate structural change, spec'd later if wanted.
- **Not** rewriting the objective or the escalation mechanism.
- **Not** adding a per-turn difficulty override UI (the band + `/why` reason is
  enough; flywheel corrects misses).

**Future — pillar C (strengthen the flywheel).** A and B make the *first pick*
less wrong; the measure-and-correct loop (`priors.ts`) is what makes routing
genuinely good over time, because no prompt-only prediction beats measured
per-repo reality ("Haiku fails code 7/9 here"). Out of scope for this spec, its
own later: widen the captured outcome signals (escalation-was-needed, manual model
override, user re-run, explicit 👍/👎), let measured evidence influence below the
current `MIN_N = 8` with low confidence instead of staying silent, and keep
surfacing it in `/why`. Prediction sets the prior; measurement converges it. Spec
A+B first (concrete, testable, ships the screenshot fixes); spec C next.

## Testing

- `difficulty` judge: fixture tests mapping representative prompts → expected band
  (typo → easy, "fix the race condition in the pool" → hard, "add a field to the
  config" → medium). Pure given a mocked judge response.
- Floor math: pure fixture test in the `router.ts` style — assert that
  `effDifficulty = 0.85` lifts the code floor from 0.4 toward 0.6 and excludes
  nano/Haiku-tier models, while `effDifficulty = 0` leaves the cheapest capable
  model winning.
- Account scope: fixture test that an active Azure account scopes the candidate
  pool to Azure, that "All accounts" un-scopes, and that an Azure-can't-serve case
  falls back to the full pool.
- A small labeled bake-off set of `(prompt, expected-tier)` pairs to confirm easy
  tasks stay cheap and hard ones climb — guards against cost regression from an
  over-eager judge.

## Risks / honest caveats

- Prompt-only difficulty is uncertain: the judge will sometimes call an easy task
  hard (cost regression) or a hard task easy (a weak pick). Mitigations: `max`
  combine keeps small easy tasks cheap; conservative band→score mapping; the
  existing reactive escalation + per-repo priors correct misses over turns;
  bake-off calibration of the band scores.
- **Cheapest-model judge accuracy.** The very cheapest model may misjudge
  difficulty — the exact axis we need it for. This is bounded, not blind: the
  lexical fast-path handles the obvious cases without it; the bake-off set
  validates that the chosen cheapest model clears a minimum accuracy on the
  labeled pairs, and a model that fails is excluded so the floor drops to the
  next-cheapest. If even mid-cheap models can't judge reliably, raise the
  `classify`-kind floor slightly (one number, not an architecture change) — the
  judge stays cheap, just not rock-bottom.
- The ~600ms blocking judge adds latency on confident-keyword code turns
  (cache-miss only). Acceptable against a multi-second coding turn; revisit if it
  bites.
- Active-account scoping changes default routing reach — fewer cross-account
  picks. This is the intended behavior change; `/why` and the status bar must make
  the scope obvious so it never feels like the router "can't see" other accounts.
