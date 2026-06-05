# Gearbox — Roadmap

Near-term build order. The north star is `VISION.md` (ROUTE · VERIFY · ACCOUNT);
the full milestone vision is `DESIGN.md`. This file tracks what's done and what's next.

## Where we are

### Done — M0 harness
- Multi-provider agent loop through the `ModelSelector` seam.
- Tools: read / write / edit / list / **search (ripgrep)** / **glob** / run_shell.
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
- `gearbox auth` headless subcommand (list / import / add / test / rm).

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

## Build order (next)

### 1 · VERIFY — ground-truth gate + auto-iterate-to-green  ← recommended next
- Detect configured checks (test / build / typecheck commands); run them as the gate.
- Tiered "done with proof": tests pass → done; else build + types + smoke; offer to
  generate a characterization test. The gate states which tier it cleared.
- Auto-iterate to green (bounded attempts/budget); honest "blocked" if it can't.
- *Why:* biggest standalone "better than other harnesses" moment; attacks the #1
  pain (plausible-but-wrong code); makes "walk away" credible. No routing priors needed.

### 2 · ROUTE v2 — the full USP
- Credit/scarcity scoring (preserve the low-balance account).
- Plan-first: model flat-rate seats as ~0 marginal cost until rate limit.
- Rate-limit awareness (read `x-ratelimit-*` headers; failover on 429/5xx).
- Hard budget caps (task/session/daily) with pre-flight enforcement.
- Shadow-eval on a sampled fraction to start measuring real per-repo priors.
- Transparency scorecard with confidence (seeded vs measured).

### 3 · Ledger + flywheel
- Canonical model-agnostic event-log ledger (single-writer, crash-safe).
- Curation → bounded working context → cheap task-boundary switching + poisoning recovery.
- Per-repo priors auto-tuned from accept/edit/revert (git signal). Durable resumable sessions.

## Quick wins (slot in opportunistically)
- More robust `edit_file` (current single-occurrence string replace is fragile).
- `/init` to generate a GEARBOX.md project guide.
