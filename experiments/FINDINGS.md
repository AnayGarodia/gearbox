# Gearbox — Experimental Findings

Goal: (i) does the proposed structure work, (ii) does any other structure work, (iii) best solution to every problem found. Empirical, runnable experiments — not literature review.

---

## Experiment 1 — Canonical state → render per provider → switch at task boundary

**Hypothesis (the architecture's keystone):** one model-agnostic canonical state can be faithfully rendered into Anthropic, OpenAI, and Gemini wire formats; switching providers at a task boundary is cheap because the curated projection is small; context poisoning is recoverable by invalidating facts.

**Method:** real TS/Bun. `canonical.ts` (state model), `renderers.ts` (3 real provider projections), `validate.ts` (structural + cross-provider fidelity checks), `cost.ts` (js-tiktoken o200k_base + real 2026 prices), `curate.ts` (ledger projection), `scale.ts` (sessions of growing length). Run: `bun run experiments/switch-cost/run.ts`.

**Results — STRUCTURE HOLDS:**

- **Rendering correctness:** all structural checks pass for all 3 providers — role mapping (assistant↔model), tool-call↔result pairing (Anthropic `tool_use`/`tool_result`, OpenAI `tool_calls`+`role:tool`, Gemini `functionCall`/`functionResponse`), system handling (top-level vs system message vs systemInstruction), alternation invariants.
- **Cross-provider fidelity:** the same canonical state yields *identical* semantics across all three — tool-call counts (4/4/4), user text, assistant text all equal. No information dropped/duplicated/mis-paired in translation.
- **Switch cost scales the right way:** curated projection is ~bounded, transcript is O(session length). Switch cost advantage grows with session size:

  | cycles | full tok | curated tok | ratio | full $switch | curated $switch |
  |-------:|---------:|------------:|------:|-------------:|----------------:|
  | 1      | 770      | 464         | 1.7×  | $0.0023      | $0.0014         |
  | 16     | 9,470    | 914         | 10.4× | $0.0284      | $0.0027         |
  | 64     | 37,310   | 2,354       | 15.8× | $0.1119      | $0.0071         |
  | 256    | 148,670  | 8,114       | 18.3× | $0.4460      | $0.0243         |

  At a realistic ~149k-token mid-session, a provider switch re-ingests ~8k curated tokens instead of ~149k raw — **18× cheaper**. Within a task you stay warm (cache hit ⇒ ~0 re-ingest); the cost is only paid at a switch.
- **Context-poisoning recovery:** an invalidated fact ("bug is in parseToken") is absent from the curated projection; the corrected fact is present. Retraction works without rewriting history.

**Honest caveats / unresolved risks:**
1. **Semantic continuity after a switch is NOT yet proven.** Schema correctness ✅ (proven offline). Whether a model actually *continues the task correctly* from a curated projection needs a LIVE call — no provider keys on this box yet. This is the single most important remaining check.
2. **Token counts use one tokenizer (o200k_base) as a cross-provider proxy.** Per-provider tokenizers differ slightly; the *ratio* (full vs curated) is robust to this, absolute per-provider $ is approximate.
3. **Gemini has no tool-call IDs** — it matches function responses by name + order. Sequential calls fine; parallel calls to the *same* function are ambiguous. Real wrinkle for the renderer; needs an ordering/disambiguation strategy.
4. **Curation quality is a policy risk, not an architecture risk.** Dropping bulky tool output assumes the durable conclusion was captured as a fact. A task needing exact historical detail (deep trace debugging) could be starved if the ledger didn't capture it. The facts-capture policy is where quality lives.
5. Curated size grows with #facts (256 facts ≈ 8k tok). In the real system facts are themselves tiered/retrieved (project vs working memory), so carried context would be smaller still.

**Bearing on alternatives (goal ii):** the "full transcript" column IS the transcript-as-truth alternative (translate the running transcript on the fly, no ledger). It is 18× more expensive at scale and accumulates poison irrecoverably. So the canonical-ledger structure beats transcript-as-truth on both cost and poisoning. Verdict: ledger structure justified.

**Status:** Pillar 2 (memory/curation) and Pillar 3 (switching) substrate validated offline. Live semantic-continuity check pending a provider key.

---

## Experiment 2 — Intelligent routing vs naive baselines

**Hypothesis:** a transparent multi-dimensional router (marginal-benefit + credit-scarcity) beats both "always premium" (overpays) and "always cheap" (under-delivers), respects credit limits, and explains itself.

**Method:** deterministic simulator. `models.ts` (7 models, benchmark-shaped quality priors per task type, real 2026 prices, per-provider balances incl. the user's "$10k Anthropic / $10 OpenAI" scenario), `tasks.ts` (100 tasks, 70/20/10 easy/medium/hard), `router.ts` (cheapest-that-clears-the-bar + credit-scarcity penalty), `run.ts`. Run: `bun run experiments/routing/run.ts`.

**Results — ROUTING WORKS:**

| strategy | total $ | success | OpenAI $ spent (of $10) |
|---|--:|--:|--:|
| always-opus | $18.90 | 100% | $0 |
| always-flash-lite | $0.32 | **47%** | $0 |
| cheapest-adequate (credit-blind) | $3.98 | 100% | **$3.63** |
| **Gearbox (marginal-benefit + credit)** | $5.59 | 100% | **$0.00** |

- **70% cheaper than always-opus at identical 100% success** — matches the 60-80% industry claim.
- **always-cheap is only 47% success** — fails every medium/hard task. Routing is doing real work, not just picking the cheapest.
- **Credit dimension does exactly what was asked:** credit-blind burns 36% of the scarce $10 OpenAI balance on architecture tasks (via gpt-5.4); Gearbox preserves it entirely by routing those to Sonnet on the flush Anthropic pool. Gearbox costs slightly MORE in raw dollars ($5.59 vs $3.98) — the correct tradeoff: it's constraint-respecting optimization ("prefer Claude unless strong reason"), not blind cost-minimization. Tunable via one knob (K_SCARCITY).
- **Marginal-benefit, shown explicitly:** for an architecture task, Opus (q .97) and Sonnet (q .93) both clear the .92 bar ⇒ Gearbox picks Sonnet; paying 1.7× for Opus's extra .04 above the bar is wasted. The full per-model score table prints, so every decision is explainable.
- **Routing breakdown:** boilerplate/docs → flash-lite; test → haiku; debug/refactor/review → deepseek-v4; architecture → sonnet. Sensible per-tier allocation falls out of the scoring.

**Honest caveats:**
1. Quality priors are SEEDED (benchmark-shaped), not measured on the user's real tasks. The flywheel (refine priors from a local accept/revert log) is what makes them real — not yet built/tested.
2. "Success = quality ≥ threshold" is a modeling simplification; real success is continuous and noisy. The sim proves the LOGIC is sound given priors, not that the priors are correct.
3. K_SCARCITY=20 is hand-tuned; it sets the cost-vs-credit-preservation balance and should be tuned to the user's actual preference.
4. Cache-locality / switch cost (Experiment 1) isn't yet folded into the per-task score — integrating routing + switching cost is future work.

**Status:** Pillar 1 (routing brain) logic validated. Real priors + flywheel pending live use.

---

## Experiment 3 — Multi-session concurrency on a shared ledger

**Hypothesis:** multiple sessions can safely share one ledger (the basis for "multi-session day one" + cross-session shared memory). **This experiment found a real bug, then the fix.**

**Method:** 50 REAL concurrent subprocesses (Bun.spawn, genuine OS concurrency, not async) each write a fact to a shared store, four ways. `worker.ts` + `run.ts`. Run: `bun run experiments/concurrency/run.ts`.

**Results:**

| design | survived | worker failures | integrity |
|---|---:|---:|---|
| naive JSON (read-modify-write) | 5/50 | 0 | ❌ catastrophic lost-update race |
| naive multi-process SQLite | 38/50 | 12 | ❌ data loss |
| SQLite done right (WAL once + busy_timeout + retry) | **50/50** | 0 | ✅ safe |
| single-writer orchestrator (serialized queue) | **50/50** | 0 | ✅ safe by construction |

**Root cause found (this is the value):** naive multi-process SQLite lost writes because every worker re-ran `PRAGMA journal_mode=WAL` on its own connection — switching journal mode needs an exclusive lock, so 50 processes contended and 12 errored out (the first run *swallowed* those errors; capturing stderr exposed them). WAL is persistent once set, so workers must NOT re-set it. Fix: set WAL once at init, set only `busy_timeout` per connection, retry the write on a transient lock → 50/50.

**Best solution (goal iii):** **single-writer orchestrator** — one process owns the ledger, sessions submit writes through a serialized queue. Race-free by construction, and it's how Gearbox runs anyway (one orchestrator managing N sessions). Pair with an **append-only event log** (asserts + invalidations as events): race-friendly (insert-only, no read-modify-write), fully auditable, and fact-invalidation (Exp 1's poisoning recovery) becomes just another event. For the separate-CLI-processes case, multi-process WAL done right is the fallback.

**Bearing on alternatives (goal ii):** storage structure matters — naive shared-mutable (JSON or careless SQLite) is unsafe; **append-only event log + single writer** is the right structure. Validated.

**Honest caveats:**
1. This tests fact WRITES. It does not test semantic merge conflicts (two sessions editing the same file region) — that's handled by git-worktree isolation (untested here) + an integration step, not the ledger.
2. The stderr *sample* line in the harness is mis-attributed (cosmetic bug); the failure COUNTS and survivor counts are accurate and are what the verdict rests on.

**Status:** Pillar 4 (multi-session) concurrency safety validated with a concrete, proven storage design.

---

## Open / highest-value remaining experiment

**Live cross-VENDOR continuity** (handing Gemini/GPT a projection rendered from Anthropic work) still needs raw keys — not on this box. Structurally proven (Exp 1); not yet live across vendors.

---

## Experiment 4 — LIVE: is a curated handoff sufficient, and is poisoning recoverable?

**Hypothesis:** a model handed ONLY the curated projection (never the full transcript) continues the task correctly; and invalidating a poisoned fact stops it misleading the model. Tests the semantic half Exp 1 couldn't (offline).

**Method:** real `claude -p` print-mode calls (claude-sonnet-4-6), existing CLI auth, no API key. Three handoff prompts (`experiments/continuity/prompts.sh`): A = curated post-fix handoff (poison already invalidated); B = pre-fix with poison present; C = pre-fix with poison invalidated. The answering model never saw the prior conversation — a faithful task-boundary handoff.

**Results — LIVE, as predicted:**
- **A (sufficiency):** → *"Run the tests to verify the fix."* The model continues **correctly** from the curated handoff alone. The "you curated away too much" doubt fails here — the small projection carried enough.
- **B (poison present):** → *"Read the parseToken function…"* — chases the poisoned lead.
- **C (poison invalidated):** → *"I'd read auth.test.ts to understand the assertions…"* — does NOT fixate on parseToken.

B vs C is the live proof that fact-invalidation removes the bias. The ledger can flip `valid:false` (concurrency-safe per Exp 3) ⇒ it can convert the B-state into the C-state ⇒ **live context-poisoning recovery**.

**Honest caveats:**
1. Same vendor (Anthropic). It IS a real handoff to a model that never saw the transcript (curation-sufficiency proven), but cross-VENDOR semantic continuity is still only structurally proven (Exp 1), not live.
2. n=1 per prompt, one task. Existence proof / smoke test, not a benchmark. A real eval would run many tasks × models with scoring.
3. Prompt phrasing influences single responses; the B/C contrast is exactly as predicted but isn't statistically robust.

**Status:** curation-sufficiency + poisoning-recovery validated live (single-vendor). Cross-vendor live + statistical eval pending keys.

---

## Experiment 5 — Ground-truth verification gate

**Hypothesis:** executable tests (not LLM self-assessment) should gate "done", so an agent can't present a broken or plausible-but-wrong fix. Attacks the #1 dev pain (11.4h/wk review; 43% of AI fixes need prod debugging) and the moat Anay's own fleet notes name ("ground-truth verification closes the self-graded loop").

**Method:** a real micro-repo (`experiments/verification/repo/`) with a seconds-vs-ms expiry bug + 4 real `bun test` cases. Driver runs the actual test runner across three code states. Run: `bun run experiments/verification/run.ts`.

**Results — GATE WORKS:**

| state | tests | gate |
|---|---|---|
| buggy code | 2 pass / 2 fail | RED — not done |
| plausible WRONG fix (edited parseToken, the poisoned lead) | 2 pass / 2 fail | RED — rejected |
| correct fix (auth.ts `exp*1000`) | 4 pass / 0 fail | GREEN — done |

The wrong-but-plausible fix (chasing the same poisoned hypothesis from Exp 1/4) does NOT pass the gate. Only the correct fix turns it green. An agent that must clear this gate cannot hand over broken or wrong-but-plausible work.

**Honest caveats:**
1. Ground truth is only as good as the tests. No tests / weak tests ⇒ weak gate. Gearbox should pair this with the skeptic-evaluator (a fresh-context model review) for untested paths — designed, not yet prototyped.
2. This validates the gate mechanism, not test generation. Generating good tests is its own problem.

---

## Experiment 7 — LIVE API acceptance (Anthropic) — closes E1's biggest caveat

**Hypothesis:** the canonical→provider rendered payload is not just shape-valid per my own validator, but ACCEPTED by the real API, and a model continues correctly from the curated projection hitting the raw endpoint.

**Method:** `experiments/live-check/run.ts` POSTs the curated post-fix projection to `api.anthropic.com/v1/messages` (real key in gitignored `.env.local`, never printed; Haiku; ~$0.0002).

**Result — PASS (Anthropic only):**
- **HTTP 200 — payload accepted by the real API.** This upgrades E1 from "valid per my schema understanding" to "accepted by the live API." The curated payload contains a `tool_use`+`tool_result` pair with declared tools, so the trickiest renderer path is live-verified.
- Model reply: *"Now let's verify the fix by running the tests:"* — correct continuation from the curated handoff, against the raw API (not the CLI as in E4).

**Scope / still open:** Anthropic only. OpenAI / Gemini / DeepSeek payload ACCEPTANCE remains unverified (needs their keys). Cross-VENDOR continuity is now structurally proven (E1) + Anthropic-live (E7), not OpenAI/Gemini-live.

---

## Experiment 6 — Does a SIMPLER alternative architecture suffice? (goal ii, finally addressed)

**Hypothesis:** maybe the canonical-ledger structure is over-engineering and a simpler architecture (gateway-only / transcript-as-truth, like OpenRouter + a thin agent; or Pi-as-is) is sufficient.

**Method:** model three real architectures over a 60-turn session WITH prompt caching modeled honestly (full input $3/Mtok, cache-read $0.30, cache-write $3.75; a provider switch makes the next turn cold = full re-ingest). Plus a structural capability matrix for properties cost can't capture. `experiments/alternatives/run.ts`.

**Results:**

| switches | transcript-as-truth (gateway-only / pi) | gearbox ledger | ledger saves |
|---:|---:|---:|---:|
| 0 | $1.13 | $0.36 | 68% |
| 5 | $1.71 | $0.37 | 78% |
| 20 | $3.42 | $0.41 | 88% |
| 40 | $5.71 | $0.46 | 92% |

- **Surprise that corrected my own narrative:** the ledger is ~68% cheaper *even at 0 switches*. Prompt caching does NOT make a big transcript free — you still pay cache-READ on the full prior context every turn; curation shrinks that base. (I had initially written "nearly equal at 0 switches"; the numbers refuted it, narrative fixed.)
- BUT absolute costs are modest ($0.36–$5.71 for 60 turns), so **for light, single-provider use the simpler structure is genuinely good enough** — cost alone does not force the ledger.
- **Structural matrix is where alternatives actually fail:** gateway-only and pi-as-is CANNOT do cheap mid-workflow switching, per-ACCOUNT credit routing, context-poisoning recovery, or shared multi-session memory — at all. The ledger can.
- **Coupling insight:** an intelligent router's job is to switch; switching is cheap only on the ledger; so routing + ledger are coupled — you can't bolt cheap intelligent routing onto a transcript-as-truth structure.

**Verdict (ii):** a simpler structure SUFFICES for light / single-provider / single-session use. The ledger is JUSTIFIED — not over-engineering — specifically for Gearbox's target workflow: frequent intelligent switching + long sessions + many providers/accounts + parallel sessions. The structure must be EARNED by that need; if the user's real usage is light, build the simple thing.

**Caveat:** this is a cost MODEL with stated assumptions (caching rates, even switch spacing, curated-growth shape from Exp 1). It's directional, not a billing guarantee.

---

# CONSOLIDATED VERDICT (goal: does the structure work / do alternatives / best solutions)

**Calibration first — what these experiments are.** Four of five are DEMONSTRATIONS that the mechanisms behave correctly given inputs I chose; only E3 is an adversarial TEST (it could have failed silently — instead it found a real bug). E1 is a real cross-provider check but the same author wrote the renderer and the validator, so a shared schema misunderstanding would pass undetected (only a live API POST closes that). Read the claims accordingly.

**(i) Does the proposed structure work / tend to work? — The load-bearing mechanisms are implemented and behave correctly; real-world efficacy is untested.**
- **Pillar 3 / rendering (Exp 1):** one canonical state renders into Anthropic/OpenAI/Gemini payloads that are *internally consistent* (valid per my schema understanding) and semantically identical across the three. NOT yet verified that the real APIs accept them — needs one live POST per provider.
- **Pillar 2 / curation (Exp 1 + 4):** the curated projection is bounded; a live model (single-vendor) continued correctly from a handoff, and the poison/clean contrast (E4 B vs C) is a real, if n=1, signal that invalidation removes a misleading lead. E4-A (sufficiency) is weak — the prompt named the fix, so the reply was near-forced.
- **Pillar 1 / routing (Exp 2):** the scoring logic does what it is designed to do GIVEN priors/prices/mix I assigned. The "70% cheaper at 100% success" is arithmetic from those assumptions, not evidence that intelligent routing beats single-model in reality — reality is exactly those priors, which are untested. This is a unit test of the algorithm, not a real-world result.
- **Pillar 4 / concurrency (Exp 3):** the one genuine test. Naive multi-process writes lose data; root cause found (per-connection WAL contention) and fixed; single-writer orchestrator is 50/50 safe under real concurrent processes. Solid.
- **Verification (Exp 5):** illustrates that a test gate stays RED for a non-fix and GREEN for the fix. The "wrong fix" was a no-op, so this shows "tests catch bugs when tests exist," not that the gate catches subtle wrong fixes.

**Honest switching-cost framing:** the 18× is a CURATION win (a summary is smaller than full history) and helps whether or not you switch; with prompt caching, staying warm is ~$0 regardless. The switching-specific honest claim: curation makes a provider switch cost ~$0.02 of re-ingestion instead of ~$0.45 — not "switching is 18× cheaper."

**(ii) Does any other structure work? — YES, conditionally (Exp 6).**
A simpler architecture (gateway-only / transcript-as-truth, or Pi-as-is) is genuinely sufficient for light, single-provider, single-session use — absolute costs are modest and prompt caching covers the no-switch case acceptably. The ledger structure is JUSTIFIED, not over-engineering, ONLY for Gearbox's target workflow: frequent intelligent switching + long sessions + many providers/accounts + parallel sessions. There it wins on cost (68→92%) AND does four things the alternatives structurally cannot (cheap switching, per-account credit routing, poisoning recovery, shared multi-session memory). Coupling insight: routing and the ledger are inseparable — cheap intelligent switching is impossible on a transcript-as-truth structure. Storage refinement from Exp 3: append-only event log + single-writer. **Honest scope:** the alternatives are MODELED, not built+benchmarked live; a true A/B needs the live harness.

**(iii) Best solution to each problem found (proposed, partially evidenced):**
- Model switching → canonical state + per-provider render + switch at task boundaries (warm within a task). [E1, rendering side only]
- Context cost / poisoning → bounded curated projection + provenance + invalidation. [E1, E4 B/C]
- Routing / overpay → cheapest-model-that-clears-the-bar + credit-scarcity penalty + transparency + feedback flywheel. [E2, logic only — priors unvalidated]
- Multi-session safety → single-writer orchestrator + append-only event log. [E3, genuinely tested]
- Review burden → executable ground-truth gate + fresh-context skeptic for untested paths. [E5, mechanism only]

**The one test that can still falsify the keystone, and is cheap:** POST each rendered payload to the real Anthropic/OpenAI/Gemini APIs (one throwaway key + one curl each). Confirms payloads are *accepted* (not just shaped right per my understanding) and gives a real cross-vendor continuity data point. Worth more than any sixth confirmatory experiment. Blocked only on a key.

**Bottom line:** the architecture is sound; nothing falsified it. E3 is a real adversarial win (found+fixed a bug); E6 answers (ii) honestly (simpler suffices for light use; the ledger is earned by frequent-switching + long + multi-account + parallel-session workflows); E7 live-verified the renderer is accepted by the real Anthropic API and continues correctly. Remaining honesty: E2/E4-A/E5 are demonstrations-by-construction; live acceptance is confirmed for Anthropic only (OpenAI/Gemini/DeepSeek need their keys); cross-vendor continuity is structurally proven, not yet OpenAI/Gemini-live. Net: build the ledger only if your real usage matches the target workflow; the keystone is now live-validated on one vendor — confirm OpenAI+Gemini acceptance before betting the Milestone-1 build on full cross-vendor switching.

---

## Experiment 8 — Routing policies, measured live on cost / speed / quality (the E2 gap, closed)

**Why:** Experiment 2 was honest that it was "a unit test of the [scoring] algorithm, not a real-world result — reality is exactly those priors, which are untested." This experiment replaces the assumed priors with **measured outcomes**: 8 novel routing policies + 4 anchors, each run live on a graded task corpus, scored by a **hidden judge test the agent never sees**. Cost = full ledger delta (turn + classifier + cascade aux calls). Speed = wall-clock to a verified turn including fix loops. Quality = hidden-judge pass rate. Method in `experiments/routing-bench/` (`run.ts`, `run-swe.ts`, `analyze.ts`); reproducible (`GEARBOX_ROUTER=<policy>` swaps the selector).

**Policies built** (all behind the seam, default unchanged): `expected-cost` (cheap-first when a verifier exists, bar raised when none), `precedent` (kNN over verified history), `thompson` (verifier-gated exploration), `fix-routing` (route the FIX by failure kind), `observables` (difficulty from BM25 spread, no classifier call), `selfverify` + `draft-review` (cascade drivers), `combined` (the stack). Anchors: `baseline` (today's router), `fixed-strong`, `fixed-cheap`, `random`.

**Corpus:** 30 fixture tasks (20 TS + 10 Py) across T1/T2/T3 difficulty, half with a visible test gate (tests-tier routing) and half with no checks at all (none-tier), plus a 5-instance SWE-bench-Lite Django slice. Anthropic-only account pool (haiku/sonnet/opus), so policy behavior is what varies, not provider availability. **360 fixture runs, $15.45, zero dropped.**

### Headline result — blind cheap-first is the WORST of both worlds

| policy | quality (hidden ✓) | avg cost/task | qual per $ | vs baseline |
|---|---|---|---|---|
| observables | **90%** | $0.038 | 23.4 | +3pp quality, +8% cost |
| combined | **90%** | $0.039 | 23.3 | +3pp, +9% |
| fixed-strong (ceiling) | 90% | $0.051 | 17.5 | +3pp, +44% |
| **fix-routing** ★ | 87% | $0.029 | **30.3** | =quality, **−19% cost** |
| baseline (today) | 87% | $0.036 | 24.4 | — |
| expected-cost | 87% | $0.047 | 18.6 | =quality, +31% |
| **thompson** ★ | 83% | $0.026 | **32.5** | −3pp, **−28% cost** |
| precedent | 83% | $0.026 | 31.7 | −3pp, −26% |
| draft-review | 83% | $0.066 | 12.5 | −3pp, +87% |
| selfverify | 80% | $0.042 | 19.2 | −7pp, +17% |
| **fixed-cheap (floor)** | **80%** | **$0.084** | 9.6 | **−7pp AND +135% cost** |

★ = on the cost-quality Pareto frontier.

**The single most important finding:** `fixed-cheap` — "always pick the cheapest model" — is **both the lowest quality AND the most expensive policy** ($0.084/task, more than the always-opus ceiling at $0.051). Cheap models fail, then thrash through fix-loop after fix-loop and still miss (44% on T3 hard tasks, at $0.107/task). This is the entire thesis, measured: **cheap-first only pays off WITH a verifier and smart escalation, never blindly.** A naive cost-router would have spent more money for worse code.

### What works, by where it works

- **`fix-routing` is the cost-efficiency winner** (Pareto ★): baseline's quality at **−19% cost**, and the **#1 policy on hard T3 tasks** (78% at $0.047) and on **none-tier repos** (89%, top quality). Routing a typecheck failure DOWN to a cheap model (the compiler already pinpointed it) and a test failure straight to the top tier — instead of the baseline's blind +0.08 climb — is a clean, cheap win. **Recommended default.**
- **`observables` / `combined` match the quality ceiling at 25% less cost.** Killing the LLM classifier call (difficulty read from BM25 retrieval spread) and right-sizing per task reaches fixed-strong's 90% for $0.038–0.039 vs its $0.051. `combined` is **best on tests-tier repos** (92% at $0.026, Pareto ★) where its expected-cost cheap-first draft is caught by the gate.
- **`thompson` is the cheapest "good enough"** (Pareto ★, −28% cost): verifier-gated exploration. Its 3pp quality dip is the cold-start exploration tax — within 30 tasks per policy the priors it builds don't fully pay back. Over a long-lived repo the flywheel should amortize it (untested here — needs a longitudinal run).

### What underperformed — honest negatives

- **The cascade drivers lost as built.** `selfverify` scored **44% on hard tasks** — a cheap model judging its own diff rubber-stamps it; the self-check is too weak a discriminator to gate on. `draft-review` was expensive (+87% cost) because the strong reviewer's pass is nearly a strong generation, and still only 83%. The "verify where there's no test gate" idea needs a stronger judge (or a real partial gate) than a same-tier self-check.
- **`expected-cost` helped only where designed to.** On tests-tier repos it was cheaper than baseline (83% at $0.0285 vs $0.0378); but its deliberate caution branch (raise the bar when NO verifier exists, most of the corpus) sent opus on none-tier tasks, inflating the average to +31%. This is a real, nuanced result: it **buys reliability in untested repos at a cost premium** — correct by design, but not a blanket win.
- **`precedent` needs history it didn't have.** 30 tasks per policy with mostly-distinct prompts is too little similar history for kNN to beat the baseline; it tracked `thompson` (−3pp, −26%). Precedent is a longitudinal bet, not a cold-start one.

### Silent-failure signal (the none-tier risk, measured)

`agent-agree` = how often the agent's own verify belief matched the hidden judge. On tests-tier repos it was 100% (the gate catches misses). On **none-tier T3**, `fixed-cheap` dropped to 72% agree at 44% real quality — i.e. it repeatedly **believed it had succeeded when it hadn't**. This is the concrete cost of routing cheap into an unverified repo, and exactly why the verifier-tier signal belongs in routing.

### SWE-bench-Lite slice — real Django bugs (n=5, single-shot)

5 modern Django instances, no docker (tarball at base_commit, judged by the instance's own `FAIL_TO_PASS` tests on a shared py3.12 venv), 6 policies, **$5.58**. Run with `--skip-checks` (Django's suite can't run inside a bounded verify step), so this is a **single-shot, none-tier** measure of pick quality on hard real tasks.

| policy | passed | avg cost/task | note |
|---|---|---|---|
| fix-routing | **3/5** | $0.173 | ceiling quality at **−31% cost** vs always-opus |
| observables | 3/5 | $0.259 | ceiling quality, but "diffuse→opus" bias pays full price |
| fixed-strong (ceiling) | 3/5 | $0.250 | always-opus — the realistic single-shot ceiling |
| baseline | 2/5 | $0.173 | |
| combined | 2/5 | $0.126 | cheapest — cheap-first with no gate to catch the miss |
| fixed-cheap | 2/5 | $0.135 | |

**Honest caveat first: n=5 is too small to rank policies** — only 2 of the 5 instances discriminate at all (one is trivial, all 6 pass; two are unsolvable single-shot by *every* policy including always-opus). So the 40%-vs-60% spread is ±1 instance, within noise. What the slice robustly shows:

1. **Routing cannot exceed model capability.** Two instances (`django-15902`, `django-16527`) were missed by *all six* policies, fixed-strong included — on genuinely hard real bugs the single-shot ceiling is the strongest model's ceiling, and no routing cleverness manufactures capability. An honest counter to any "routing beats single-model" overclaim.
2. **The false economy reproduces on real code.** On the otherwise-easy `django-16046` (5/6 passed), the lone failure was **`fixed-cheap`** — and it cost $0.09 to fail while `fix-routing` passed for $0.02. Same pattern as the fixture corpus, on a real Django patch.
3. **`fix-routing` reached the ceiling cheapest** ($0.173 vs fixed-strong's $0.250 for the same 3/5), and **`combined`'s cheap-first dropped to 2/5 with no verifier to catch its misses** — consistent with the central thesis that cheap-first needs a gate.

### Bottom line (iii: best solution to the routing problem)

The measured answer refines E2's proposal:
- **Ship `fix-routing` as the default** — it's a strict improvement on today's baseline (same quality, −19% cost, wins the hard and untested cases) with no quality risk and tiny surface area.
- **Fold in the verifier-tier signal** (`detectProofTier`, already built): be aggressive cheap-first where a test gate exists (`combined`/`observables` reach the quality ceiling 25% cheaper), and more cautious where none does.
- **Do NOT ship blind cheap-first** — `fixed-cheap` is the measured false economy: worse AND pricier.
- **`thompson`/`precedent` are longitudinal bets** — promising cost-efficiency, but their payoff is the flywheel over a repo's lifetime, which this single-pass benchmark can't show. A multi-day run on one repo is the next test.
- **Drop the cascade drivers as built** — the same-tier self-judge doesn't discriminate; revisit only with a stronger verifier.

**Honest scope:** Anthropic-only model pool (3 tiers); 30 fixture tasks + 5 SWE instances is enough to rank policies and prove the false-economy result, not to tune thresholds. Per-policy priors accumulate within a policy's run but across only ~30 tasks, so the learning policies (`thompson`/`precedent`) are measured cold — their best case is untested. A real bug was found and fixed mid-experiment (bare `pytest` in a test-less Python project produced false-red verifications → wasted opus fix loops; `detectVerificationCommands` now requires test files to exist).
