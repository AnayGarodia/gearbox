# Gearbox — Design

A terminal coding agent whose one job, done better than anything else, is to **route each task to the right model across every provider and account you pay for**. Everything else is table stakes executed well, in service of that.

Target user: a startup founder / power user who pays for several models (Claude, OpenAI/Codex, Gemini, DeepSeek, Azure) via API keys and/or flat-rate seats, codes heavily, hits limits, and has no intelligent way to use it all.

Status: architecture validated by 6 experiments (`experiments/FINDINGS.md`); routing, event-log ledger, task-boundary switching, ground-truth gate all prototyped; Anthropic payload accepted live.

---

## Design principles (these decide every tradeoff)

1. **Routing is sacred and invisible.** It is the USP and runs on every task. It must add no perceptible latency and no visual noise. You feel its results (cost, no stalls), never its presence.
2. **Earn trust through transparency.** It spends your money. Every decision is explainable in one glance and one keystroke to the full math. Never opaque.
3. **Calm by default, depth on demand.** The screen shows what's happening now, the current model, the running cost. Everything else is one keystroke away.
4. **Honest about state.** Tests failed → it says so. Switched providers → it says so plainly. Never claims done without proof.
5. **Build on proven wheels; own only the differentiator.** The provider layer, tool-call loop, and TUI rendering are solved problems. The routing brain, the ledger, the cost/limit engine, and the UX are ours.
6. **Every milestone is something you actually use.** Routing-first. No big-bang.
7. **Open and free to run.** Fully open-source (MIT). Nothing costs money except the model calls you already pay for, on your own keys. No hosted backend, no paid dependencies, no required account, no paid telemetry. Local-first everywhere.

---

## What it is

A terminal app (rich TUI with a live dashboard) plus a scriptable CLI underneath. You run it instead of Claude Code / Codex. Local-first, your keys, your machine. Not a website, not a hosted service, not an IDE plugin. Internal tool first; productizable later because the routing + spend story is exactly what teams want.

## Openness & cost

- **License: MIT.** Fully open-source, permissive, no strings. (Apache-2.0 is the alternative if a patent grant ever matters; MIT chosen for maximum simplicity and openness.)
- **Free to run.** Every dependency is permissively licensed and runs locally: AI SDK (Apache-2.0), Bun (MIT), bun:sqlite (public domain), Ink (MIT), ripgrep (MIT/Unlicense), tree-sitter (MIT), MCP SDK (MIT). No copyleft, no hosted service, no required account, no paid backend, no server bill.
- **The only money is inference you already pay for**, on your own keys, and it is the whole point of the tool. That includes the optional "make routing smarter" calls (shadow-eval, the LLM classifier): they run on your keys, count against your budget caps, are off-or-sampled by default, and are governed by a calibration-budget knob so you decide how much to spend sharpening routing. Rules-based routing is free.
- **Code search is free and local by default** (ripgrep + tree-sitter + LSP). Embeddings are optional and local-first (a local embedding model); never a paid embeddings API by default.
- **Telemetry: none by default.** Any analytics is opt-in and local-only; nothing leaves your machine.

---

## Architecture

```
┌──────────────────────────── Gearbox (owned) ────────────────────────────┐
│  TUI / CLI  (Ink)                                                        │
│     │                                                                    │
│  Session Orchestrator (single-writer)  ── multi-session, worktrees       │
│     │                                                                    │
│  ┌──────────────┐   ┌──────────────────┐   ┌────────────────────────┐   │
│  │ ROUTING BRAIN│   │ Ledger + Memory  │   │ Verification / Autonomy│   │
│  │ classify →   │   │ append-only event│   │ tests/build/types gate │   │
│  │ score →      │   │ log, curation,   │   │ auto-iterate-to-green  │   │
│  │ pick + log   │   │ task-boundary    │   │ unattended-safe        │   │
│  └──────┬───────┘   │ switching        │   └────────────────────────┘   │
│         │           └──────────────────┘                                │
│  Cost / Credit / Limit / Plan engine  (balances, caps, failover)        │
└─────────────────────────────────┬────────────────────────────────────────┘
                                   │  model selection per task
┌──────────────────────────────── ▼ built on ─────────────────────────────┐
│  Vercel AI SDK (`ai` + @ai-sdk/{anthropic,openai,google,azure,deepseek}, │
│  OpenRouter provider)  → unified messages, tool-calling loop, streaming  │
│  Bun + bun:sqlite (WAL)  ·  Ink (TUI)  ·  MCP SDK  ·  ripgrep/tree-sitter │
└──────────────────────────────────────────────────────────────────────────┘
```

### Build on (do NOT reinvent)

| Need | Use | Why |
|---|---|---|
| Provider access, unified message format, tool-call normalization, streaming | **Vercel AI SDK** (`ai`, provider packages, OpenRouter provider) | Battle-tested, ubiquitous, covers all 5 providers + OpenRouter; its unified message type IS the canonical state I prototyped in E1; its tool-call loop (`stopWhen`/steps) is the agent loop mechanics |
| Runtime + storage | **Bun** + **bun:sqlite** (WAL) | Fast cold start, native TS, zero-dep embedded DB; event log validated in E3 |
| TUI rendering | **Ink** (React for terminals) | Standard for rich TS CLIs (Claude Code, Codex CLI use it); component model fits the dashboard |
| Cost estimation | **js-tiktoken** + provider token endpoints | Local, fast token counts for pre-call estimates (used in E1) |
| Code search / nav for tools + memory | **ripgrep**, **tree-sitter**, **LSP** (+ optional local embeddings) | Don't build search; start with ripgrep, add tree-sitter/LSP for symbol nav. All free/local. Embeddings optional and local-first (local model) — never a paid embeddings API by default |
| Tool implementations (read/write/edit/shell/grep) | adapt from **Pi / OpenCode** (MIT) as reference | Don't redesign well-solved tools |
| Tool/extension connections | **MCP SDK** | Standard; reuse your existing MCP servers |
| Config + schema validation | **TOML** + **Zod** | Boring and correct |
| Seed quality priors | **SWE-bench / Aider leaderboard / public evals** | Don't guess model quality cold |

### Own (the differentiator, no wheel exists)
Routing brain · cost/credit/limit/plan engine · canonical-state event-log ledger + curation · verification gate + autonomy controller · single-writer multi-session orchestrator · the routing-transparency UX.

> Foundation note: the AI SDK runs the per-call tool loop on whatever model Gearbox selects; Gearbox injects routing at task boundaries and wraps every call with the ledger, cost engine, and verification. This keeps routing first-class without rebuilding provider integration. Alternative considered: build on Pi's `pi-agent-core` (faster start, but retrofitting per-task routing into someone else's loop). Chosen the AI SDK for a clean, owned hot path since routing is the whole point.

---

## The routing engine (the USP — most of the engineering rigor goes here)

### What "a task" is, and the two levels of routing

A **task** = one user request / one unit of intended work ("fix the failing auth tests"). The main agent thread handles it and **stays warm on one capable model** chosen at task start. The main model only changes at a task boundary, on escalation (the work turns out harder than classified), or on failover (limit/outage). The `w_switch` penalty governs these rare main-thread changes.

Fine-grained savings do **not** come from hopping providers mid-conversation (that loses the cache and risks incoherence). They come from **delegating bounded sub-tasks to cheap models in isolated contexts**: run-and-summarize the tests, search the codebase, read-and-summarize a big file, generate boilerplate. Each sub-task gets its own cheap routing decision and its own clean context, returns a compact result to the warm main thread, and never touches the main conversation's cache. This is the "intelligent leader delegating grunt work" model, and it's where most of the easy-work-to-cheap-model savings actually live.

This also reconciles E6: cheap context reconstruction from the ledger powers both (a) spinning up many cheap sub-task contexts and (b) the occasional main-thread switch. Frequent cheapness is the sub-task surface; the switch penalty is the main-thread surface. No contradiction.

So routing runs at two levels:
- **Task level:** pick the main-thread model (clears the task bar; warm; scarcity/plan/limit aware).
- **Sub-task level:** each delegated bounded op routes independently to the cheapest model clearing that op's (lower) bar, in an isolated context.

Per task (and per sub-task), before any model call:

```
classify(task) → task_type, complexity, est_tokens
  ↓
candidates = models where quality_prior[task_type] ≥ bar[task_type]   // meet the bar
  ↓
for each candidate: score = cost_est
                            + w_scarcity · (cost_est / provider_balance)   // preserve scarce credit
                            + w_switch   · switch_penalty(currently_warm)  // cache locality
                            − w_plan     · plan_bonus(flat_rate_seat_free) // use seats you pay for
   filter out: rate-limited / over-budget / (if interactive) too-slow
  ↓
pick = argmin(score);  log(decision, per-candidate scores, reason)
  ↓
if none clears bar+budget → stop, surface to user (never silently downgrade quality)
```

**Inputs, and where each comes from**
- `task_type` / complexity: rules-first classifier (keywords + changed-file types + action verbs), < 5ms, free. Optional cheap-LLM classifier for ambiguous cases only (off by default).
- `quality_prior[type][model]`: seeded from public benchmarks; **refined per-repo** by the flywheel (accept/edit/revert signal via git).
- `cost_est`: local tokenizer × live price table.
- `provider_balance`, `rate_limit_headroom`, `seat_status`: from the cost/credit engine (cached; refreshed async + from response headers). Never a blocking network call on the hot path.
- `currently_warm`: which model this session last used (switch cost from E1).

**Transparency contract:** every decision writes a one-line reason + the full per-candidate score table to the ledger, viewable live (`tab`) and after the fact (`gearbox why <task>`).

**Calibration is part of M1, not deferred — it is what makes routing actually good, not just internally consistent.** Seeded benchmark priors are honest *guesses*; they say nothing about this user's React/TS code. So from day one:
- **Confidence is first-class.** Every prior is tagged `seeded` or `measured(n)`, and the scorecard shows it. Routing is conservative when confidence is low: it will not send a hard task to a cheap model on a seeded guess alone, it shadow-evals first. Presenting a benchmark guess as a confident number is a trust bug, not cosmetics.
- **Shadow-eval loop.** On a sampled, budget-capped fraction of tasks/sub-tasks, also run the next-cheaper candidate, diff against the chosen model's output (and against ground truth where tests exist), and update the prior from real data. The git accept/edit/revert signal is a second, noisier input.
- **Per-repo priors.** Calibration is scoped to the repo; a model can be strong here and weak elsewhere.

**The headline measurement (M1 exit criterion):** on a real session with live keys, routed cost vs all-frontier cost, plus an explicit check that the cheap picks were actually good enough (held against tests / not reverted). That is the USP's first real test — every experiment so far used synthetic priors. The flywheel's heavier auto-tuning (M5) refines this; the basic shadow-eval + confidence ship in M1.

**Cost / credit / limit / plan engine** (routing's data source):
- **Onboarding is load-bearing and explicit, not a footnote** (plan-first and limit-failover depend on it). A first-run setup detects keys from env / existing CLI configs, then asks per provider: metered API key, flat-rate seat (and its plan tier → known rate limits), or both. Limits are inferred from response headers where available and overridable in config. Without this, plan-first can't work, so it's a real onboarding UX surface, not config trivia.
- Tracks spend per provider locally (authoritative, since balance APIs are inconsistent); reconciles with provider usage headers when present.
- **Plan-first:** model a flat-rate seat (Claude Max, ChatGPT Pro) as ~0 marginal cost until its rate limit, then fall back to metered API.
- **Limit-aware:** read `x-ratelimit-*` headers; as headroom drops, deprioritize; on 429/5xx, failover to the next candidate and continue the same task.
- **Hard caps:** per-task / per-session / daily. Pre-flight estimate before each call; if it would breach the cap, halt and ask. Never blow the cap by more than one pre-estimated in-flight call.

---

## Every feature (tagged by milestone)

**Routing (M1 — the USP, built to a high bar)**
- Per-task automatic model selection across all configured providers.
- Sub-task delegation: bounded ops (run tests, search, summarize, boilerplate) routed to cheap models in isolated contexts — the fine-grained savings surface, no cache loss.
- Per-repo calibration: shadow-eval loop + seeded-vs-measured confidence on every prior.
- Marginal-benefit scoring (cheapest model that clears the task's quality bar).
- Credit-scarcity awareness (prefer the flush account; preserve the scarce one).
- Plan/subscription-first (use seats you already pay for before metered API).
- Rate-limit awareness + seamless failover (don't dead-end on a limit).
- Hard budget caps (task/session/daily) with pre-flight enforcement.
- Live, per-decision transparency (one-line reason + full scorecard on demand).
- One-keystroke override; override logged as a preference.
- Latency-class routing (fast model when you're waiting, best when it's background).
- Free-tier / local-model (Ollama) tier as the cheapest rung.

**Agent core (M0 — table stakes, on the AI SDK)**
- Plan → tool → observe → act loop; tools: read, write, edit, shell, grep/search, ls.
- Streaming output; interruptible.
- Project instructions file (a `GEARBOX.md` / reuse `CLAUDE.md` if present).
- Safe-by-default permissions (ask before shell/writes outside cwd).
- Plan mode before large changes.
- MCP tool connections.

**Ledger + memory (M2)**
- Canonical model-agnostic state as an append-only event log (crash-safe).
- Curation → bounded working context (cheap task-boundary switching).
- Fact provenance + invalidation (recover from a wrong assumption).
- Decision/ADR record that survives compaction.
- Durable, resumable sessions (survive kill -9 / reboot).

**Verification + autonomy (M3 — the "walk away" pillar)**
- Ground-truth gate: configured tests / build / type-check must pass before "done".
- Auto-iterate to green (bounded attempts), then surface honestly if stuck.
- Unattended-safe: no stall on limits, hard cost cap, no drift over long runs.
- Honest status protocol (done-with-proof / blocked / needs-input).

**Multi-session + UX (M4 — design-heavy)**
- Concurrent sessions on different tasks; git-worktree isolation.
- Shared project memory across sessions.
- Live dashboard: session board, per-session model + cost + status.
- The always-visible cost meter; amber near caps.

**Spend record + flywheel (M5)**
- One searchable record of what every model changed and what it cost, across accounts.
- Per-task / per-project spend attribution.
- Routing flywheel: priors auto-tuned per repo from accept/revert.

**Later (only if earned)**
- Background/async task queue (gated by the verification + cost-safety pieces).
- Local model fine-tuning of the classifier.
- Team mode / shared spend dashboards (the productization path).

**Explicitly cut** (judged solutions-looking-for-problems): branch/rewind sessions, try-the-same-task-N-ways, cross-model "jury", sensitivity/privacy routing.

---

## Strict requirements (hard numbers — non-negotiable)

**Latency (the routing hot path is sacred):**
- Routing decision (rules path): **< 10ms p50, < 25ms p99**. Pure local compute.
- Total overhead added before time-to-first-token (classify + score + cost-est): **< 50ms p99** — must be dwarfed by model TTFT (300–800ms) and never perceptible.
- Optional LLM classifier: **< 500ms p95**, used on **< 15%** of tasks, **off by default**.
- Balance / limit / seat read: from in-memory cache, **< 1ms**, never a blocking network call on the hot path; refreshed async (≤ 60s) and from response headers.
- Cost estimate (tokenize 16k ctx): **< 20ms**.
- Ledger event append: **< 5ms p99**, off the response-critical path, fsync'd for durability.
- Failover pick on 429/5xx: **< 50ms** to select the next model.
- TUI frame: **< 16ms (60fps)**; routing panel render **< 5ms**; UI thread never blocks on I/O.
- Cold start to interactive: **< 400ms**.
- Stream relay overhead: **< 50ms** over the provider's own stream.

**Durability / correctness:**
- Crash-safe: every state-changing event fsync'd before ack; a `kill -9` session reconstructs to the last completed event.
- No lost writes with **≤ 16 concurrent sessions** (single-writer queue + WAL; validated E3).
- Routing is **deterministic** on the rules path (same state + config → same pick) and always logged with reasons.
- Budget caps are **hard**: a session cannot exceed its cap beyond one pre-estimated in-flight call.
- "Done" cannot be declared with failing configured checks.

**Security:**
- API keys never logged, never written to the ledger, never sent to a provider other than their own. Keys read from env or a `0600` local file.

**Cost of the tool itself:**
- **Zero-cost-to-run guarantee:** no Gearbox feature requires payment beyond the user's own model inference. No paid dependency, hosted backend, required account, or paid telemetry, ever. The only $ are model calls on the user's keys, all counted against caps.
- Rules routing: $0 (local). Optional LLM classifier: **< $0.001/decision**, bounded, off by default.
- Shadow-eval/calibration inference is opt-in, sampled, and bounded by a calibration-budget knob; it counts against the normal caps.
- Curation keeps typical working context **< 16k tokens**.

**Scale:**
- ≥ 8 concurrent sessions with no UI jank; sessions with 1000+ events with no slowdown (indexed SQLite).

---

## UX & design (this matters as much as the engine)

**Main session view** — calm; the routed line is dim, the cost meter always present:
```
┌ gearbox ·············································· today $0.04 / $20 ┐
│ repo gearbox · session fix-auth · ◐ sonnet-4.6                          │
├─────────────────────────────────────────────────────────────────────────┤
│ › fix the failing auth tests                                            │
│ ▸ read auth.ts, token.ts                                                │
│ ▸ ran tests → 2 failing (expiry)                                        │
│ ● editing auth.ts … exp compared in seconds vs ms                       │
│                                                                         │
│ ┄ routed debug → sonnet-4.6 · cleared bar, haiku too weak · ~$0.012 ⌃tab│
├─────────────────────────────────────────────────────────────────────────┤
│ session $0.03 · anthropic ✓ · openai ⚠ low · ⌃o override  ⌃w why        │
└─────────────────────────────────────────────────────────────────────────┘
```

**Routing scorecard** (`⌃tab`) — the full math, including *confidence*, which is the real trust-builder (never show a benchmark guess as a confident number):
```
╭ why: "fix the failing auth tests"  (debug, ~3.1k tok) ───────────────────────────╮
│ model         quality  source         est$     balance  score  verdict            │
│ sonnet-4.6    0.91 ✓   your 47 tasks  $0.012   $9,991   0.41   ◀ chosen            │
│ deepseek-v4   0.90 ✓   seed · guess   $0.003   $20      0.43   ≈ shadow-evaling    │
│ gpt-5.4       0.91 ✓   your 12 tasks  $0.010   $10 ⚠    0.78   scarce credit       │
│ haiku-4.5     0.78 ✗   your 31 tasks  $0.001   $9,991    —     below bar (0.86)     │
│ rule: cheapest clearing 0.86 on a non-scarce account. deepseek's 0.90 is a benchmark│
│ guess, so it's being shadow-evaled on your code before it's trusted to win. [o]verride│
╰────────────────────────────────────────────────────────────────────────────────────╯
```

**Multi-session board:**
```
┌ gearbox · 3 sessions ······························· today $0.12 / $20 ┐
│ ● fix-auth        debug      sonnet-4.6   $0.03   editing auth.ts       │
│ ● add-search      feature    gpt-5.4      $0.06   running tests         │
│ ◐ refactor-cache  refactor   deepseek-v4  $0.03   ✓ done · tests green  │
└──────────────────────────────────────────────────────────────────────────┘
```

**UX rules:**
- The hot path is silent: routing shows as one dim line, never a modal, never a spinner of its own.
- Cost meter always visible, never alarming; amber approaching a cap, red only on a real failure.
- Failover is narrated plainly: `openai rate-limited → moved to gemini, continuing`. Not hidden, not scary.
- Override is one keystroke and feels respected (logged as preference, feeds the flywheel).
- Color discipline: one accent for routing, amber for cost, red only for failures; high-contrast monospace; motion only to show live streaming.
- Keyboard-first; every action reachable without the mouse.

---

## Build sequence (routing-first; each step is usable)

- **M0 — Foundation spike (~1 wk).** AI SDK provider layer + minimal agent loop + 4 tools + config + streaming, talking to all 5 providers with manual model choice. De-risk: confirm the AI SDK message type carries our canonical state and tool-calls across every provider with real keys (extends E1/E7). *Usable: a bare agent on any provider.*
- **M1 — Routing, done insanely well (~3–4 wks). This is the product.** Two-level routing (warm main-thread model + cheap sub-task delegation in isolated contexts), classifier, scorer, cost/credit/limit/plan engine, failover, hard caps, the transparency log + scorecard *with confidence*, override. **Calibration ships here, not later:** shadow-eval loop + per-repo measured priors + the seeded-vs-measured confidence display. Strict latency budget enforced and measured. **Exit criterion (the USP's first real test, live keys):** on a real session, routed cost vs all-frontier cost, *plus* an explicit check that the cheap picks were good enough (held against tests / not reverted). If that check fails, the routing isn't done. *Usable: it routes your real work, shows why with honest confidence, and you trust it with your money.*
- **M2 — Ledger + memory + cheap switching (~1–2 wks).** Event-log ledger (single-writer), curation, task-boundary switching, crash-safe resumable sessions, invalidation. *Usable: long sessions stay cheap and coherent; switching is ~free.*
- **M3 — Verification + autonomy (~2 wks).** Ground-truth gate, auto-iterate-to-green, unattended-safe controls. **Define "done with proof" for the common case of untested code** (most founder repos): tiered — if tests exist, they pass; otherwise require build + type-check + a smoke run, and offer to generate a characterization test pinning the changed behavior. The gate is never vacuous; it states which tier it cleared. *Usable: hand it a task and walk away.*
- **M4 — Multi-session + TUI/UX polish (~2 wks).** Concurrent sessions, worktrees, the dashboard, the design layer. *Usable: run several tasks, one calm board.*
- **M5 — Spend record + advanced auto-tuning (~1 wk).** Searchable cross-account record, spend attribution, and heavier auto-tuning of priors (the basic shadow-eval + confidence already shipped in M1). *Usable: spend is one searchable place; routing keeps sharpening on your code.*

Re-evaluate against daily use before any "Later" item or productization.

---

## Risks / open

- **AI SDK fit:** confirm its message type round-trips our canonical state + tool-calls across all 5 providers (M0 spike; only Anthropic live-verified so far).
- **Balance APIs are inconsistent:** some providers don't expose balance. Mitigation: local spend tracking is authoritative; reconcile with headers where available.
- **Plan/seat modeling is the hardest input:** flat-rate seat limits aren't cleanly exposed. Start with usage-header inference + user-declared limits; refine.
- **Quality priors are seeds, not truth (the core risk):** addressed by moving calibration into M1 (shadow-eval + measured per-repo priors + confidence display) rather than deferring it. Residual risk: shadow-eval costs extra on sampled tasks and takes real usage to converge; until it does, routing leans conservative and labels guesses as guesses. Routing is only as good as this loop, so it gets the most rigor.
- **"Task" granularity & savings ceiling:** resolved by the two-level model (warm main thread + cheap sub-task delegation). Residual: deciding *what* to delegate vs keep on the main thread is a real heuristic to tune.
- **Verification on untested code:** resolved by tiered done-with-proof (tests → build+types+smoke → offered characterization test); residual is how aggressively to auto-generate tests.
- **Cross-vendor live acceptance** (OpenAI/Gemini) still unverified — close in M0 with real keys, alongside the M1 headline cost-vs-quality measurement.
