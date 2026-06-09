# Gearbox — Roadmap

Near-term build order. The north star is `VISION.md` (ROUTE · VERIFY · ACCOUNT);
the full milestone vision is `DESIGN.md`. This file tracks what's done and what's next.

## Where we are — harness, accounts, VERIFY, and most of ROUTE v2 are shipped

### Done — M0 harness
- Multi-provider agent loop through the `ModelSelector` seam.
- Tools: read / write / edit / list / **search (ripgrep)** / **glob** / run_shell /
  **fetch_url** / **web_search**, plus **delegate / delegate_parallel** sub-agents
  and **MCP tools** (`mcp_<server>_<tool>`).
- **Permission gate** with once / always / **YOLO** (`/yolo`, `--yolo`).
- Plan mode, streaming, `@file` mentions, `!shell`, slash commands.
- Fullscreen UI (default): virtualized scroll region (line buffer + Viewport), full-width chrome,
  mouse + PgUp/PgDn scroll, Boo mascot, compact working indicator.
- Multi-line composer, readline editing, bracketed paste.
- Sessions persist per-project; `/resume`, `--continue`.

### Done — ACCOUNT foundation
- Model corpus with quality (SWE-bench), cost ($/Mtok), latency, tokenizer calibration
  per model (`src/model/profiles.ts`; provenance-tagged: measured / researched / seeded).
- Calibrated token counting with js-tiktoken × per-model calibration (`src/model/tokens.ts`).
- Live `$` cost estimate in the status bar; per-account spend ledger (`src/accounts/usage.ts`).
- Rate-limit snapshot + balance tracking per account.
- Multi-account system: API key, AWS, Azure, Vertex, CLI subprocess, OpenAI-compat.
- Headless subcommands: `gearbox auth` (list / import / add / test / rm / providers),
  plus `gearbox onboard`, `gearbox mcp`, `gearbox doctor`, `gearbox upgrade`.

### Done — Context engine
- BM25 lexical retrieval — top-K relevant files per prompt, no model call (`src/context/retrieve.ts`).
- Repo map in system prompt; project memory (GEARBOX.md / CLAUDE.md).
- History curation: elide old tool exchanges, keep recent turns verbatim; trim to context window.
- Tool-pair sanitization (balanced tool_use / tool_result guaranteed before every send).

### Done — Basic ROUTE
- `RoutingSelector` is the live default (`cli.tsx`; `FixedSelector` only when a model is pinned).
- Prompt classifier: mutating verbs → code; summarize/classify/search patterns → cheap kind.
- Quality bar per task kind (SWE-bench-derived); filter then cheapest-first cost sort.
- `/prefer kind model` remembers confirmed routing preferences (`src/model/preferences.ts`).
- One-line reason shown in the status bar.

### Done — ROUTE v2 engine
- Credit/scarcity scoring — preserve the low-balance account (`src/model/scoring.ts`).
- Plan-first: flat-rate subscription seats scored as ~$0 marginal cost until their
  rate limit, then failover to metered API (`src/model/router.ts`).
- Rate-limit awareness: `x-ratelimit-*` response headers feed the scorer
  (`src/model/rate-headers.ts`).
- Hard spend caps — session / daily / monthly / total via `/cap`, pre-flight enforced
  (`src/model/budget-guard.ts`).
- Transparency scorecard: `/why` shows every candidate's score, with provenance.

### Done — VERIFY
- Ground-truth gate: detect configured checks (test / build / typecheck commands) and
  run them after edits (`src/verify.ts`).
- Tiered "done with proof" (`provenTier`): tests > types > none — the gate states which
  tier it cleared.
- Auto-iterate to green (≤ 3 attempts via `buildFixPrompt`); honest "blocked" if it can't.
- Characterization-test offer when nothing covers the change — `/verify test` writes one;
  `/verify off|auto` controls the gate.

### Done — Ledger core
- Canonical single-writer spend ledger (`src/accounts/ledger.ts`): every turn goes through
  the `recordSpend` choke point → usage.json aggregates + append-only `~/.gearbox/ledger.jsonl`
  + session TurnMeta; crash-safe temp-rename writes.
- Sessions are durable and resumable (`/resume`, `--continue`).

## Build order (next)

### 1 · ROUTE v2 — what's left
- Shadow-eval on a sampled, budget-capped fraction of tasks.
- Per-repo measured priors from real outcomes (seeded guesses → measured confidence).

### 2 · Flywheel
- Per-repo priors auto-tuned from accept/edit/revert (git signal).
- Curation → bounded working context → cheap task-boundary switching + poisoning recovery.
