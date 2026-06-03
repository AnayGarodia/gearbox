# Gearbox — Roadmap

Near-term build order. The north star is `VISION.md` (ROUTE · VERIFY · ACCOUNT);
the full milestone vision is `DESIGN.md`. This file tracks what's done and what's next.

## Where we are (the harness — done)

A solid M0 foundation:
- Multi-provider agent loop through the `ModelSelector` seam (routing not built yet —
  `FixedSelector` returns a default).
- Tools: read / write / edit / list / **search (ripgrep)** / **glob** / run_shell.
- **Permission gate** with once / always / **YOLO** (`/yolo`, `--yolo`).
- Plan mode, streaming, `@file` mentions, `!shell`, slash commands.
- Fullscreen UI: virtualized scroll region (line buffer + Viewport), full-width chrome,
  mouse + PgUp/PgDn scroll, the Cog mascot, a compact working indicator.

## Build order (each phase compounds toward the pillars)

### 1 · ACCOUNT foundation — cost meter → spend ledger
- A price table per model (input/output $/Mtok) in the provider registry.
- Multiply by the token usage already captured in `agent/run.ts` → per-turn and
  session cost; show live `$` in the status (the slot exists).
- Persist a per-task / per-project spend record (append-only).
- *Why first:* independently useful, smallest, and it's the data ROUTE needs.

### 2 · VERIFY — ground-truth gate + auto-iterate-to-green  ← recommended next
- Detect configured checks (test / build / typecheck commands); run them as the gate.
- Tiered "done with proof": tests pass → done; else build + types + smoke; offer to
  generate a characterization test. The gate states which tier it cleared.
- Auto-iterate to green (bounded attempts/budget); honest "blocked" if it can't.
- *Why:* biggest standalone "better than other harnesses" moment; attacks the #1
  pain (plausible-but-wrong code); makes "walk away" credible. No routing priors needed.

### 3 · ROUTE v1 — the USP
- Rules-first classifier (task_type, complexity, est_tokens) — <10ms, free.
- Score candidates: cost_est + scarcity penalty + plan-first bonus − switch penalty;
  filter by quality_prior ≥ task bar. Pick via the `ModelSelector` seam (no upstream changes).
- Transparency: one-line reason + scorecard with **confidence** (seeded vs measured).
- Shadow-eval on a sampled, budget-capped fraction to start measuring real priors.
- *Depends on:* the ACCOUNT cost data.

### 4 · Ledger + flywheel
- Canonical model-agnostic event-log ledger (single-writer, crash-safe).
- Curation → bounded working context → cheap task-boundary switching + poisoning recovery.
- Per-repo priors auto-tuned from accept/edit/revert (git signal). Durable resumable sessions.

## Quick wins (slot in opportunistically)
- More robust `edit_file` (current single-occurrence string replace is fragile).
- Multi-line input / paste in the composer.
- Project context: load `CLAUDE.md`/`AGENTS.md`/`GEARBOX.md` + a repo map into the
  system prompt; `/init` to generate one. (High day-to-day value, low risk.)

## Recommended next
**Phase 2 (VERIFY)** — strongest standalone differentiator and trust foundation.
Alternative: Phase 1 (ACCOUNT) if going straight at routing.
