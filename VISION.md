# Gearbox — North Star

The overarching goal, kept deliberately high-level. Detailed product spec lives in
`DESIGN.md`; the near-term build order in `ROADMAP.md`. If a proposed build doesn't
serve a pillar below (or the base), question whether it belongs.

## The one line

**Gearbox is the intelligent layer across all your models: it picks the right model
for each task, proves the work is actually correct, and shows you exactly what it
cost — on your own keys.**

## The gap it fills

Every other harness gives you **one smart model with good tooling**:
- Claude Code → Anthropic only. Codex → OpenAI only. Gemini CLI → Google only.
- Aider → multi-provider but a dumb pipe (you pick the model; it's edit-focused).
- Gateways (OpenRouter) → route across providers with zero intelligence about *which* model for *which* task.

The structural gap: **you pay for several models and plans, can only use one at a
time per tool, and have no intelligent way to allocate them.** Gearbox owns that layer.

## Three pillars

- **ROUTE** — the right model per task, across every provider and account you pay
  for. The cheapest model that clears the task's quality bar; credit-scarcity aware
  (preserve the scarce account); plan-first (use flat-rate seats before metered API);
  limit-aware failover. This is the USP — it runs on every task and must be invisible.
- **VERIFY** — work is proven correct by executable ground truth (tests / build /
  type-check), not the model's self-assessment. "Done" requires proof; the agent
  iterates to green or says it's blocked. Attacks the #1 pain: plausible-but-wrong code.
- **ACCOUNT** — full, honest spend visibility across every account. One searchable
  place to see what every model changed and what it cost, attributed per task/project.

## The base (non-negotiable)

Open (MIT), local-first, **your own keys**, no hosted backend, no required account,
no lock-in, no paid telemetry. Calm and beautiful. **Transparent** — every routing
decision explainable in one glance and one keystroke, with honest *confidence*
(seeded-guess vs measured-on-your-code). **Honest about state** — tests failed → it
says so; switched providers → it says so plainly; never claims done without proof.

## The leaps beyond "best of each"

What the routing + ledger architecture uniquely enables (no harness does these):
- **Model orchestration, not just selection** — a leader model delegates bounded
  sub-tasks (run tests, search, summarize, boilerplate) to the cheapest capable model
  in parallel isolated contexts; the smart model stays warm.
- **Cross-model verification** — a different model lineage checks the first's work.
- **Confidence-calibrated autonomy** — escalate when uncertain instead of being
  confidently wrong.
- **Per-repo flywheel** — learns which model is actually good at *your* code.
- **Budget as a dial** — "spend up to $X on this task, maximize quality within it."

## Explicitly not doing

No hosted backend, paid dependencies, or telemetry-by-default. And (judged
solutions-looking-for-problems): branch/rewind sessions, try-the-same-task-N-ways,
cross-model "jury" voting, sensitivity/privacy routing.
