# Gearbox bug triage (overnight sprint)

Status legend: ☐ todo · ◑ in progress · ☑ fixed (green) · ⚠ needs live verification (implemented + unit-tested, but only you can confirm in a real terminal/with your accounts) · ✗ won't-fix/by-design · ↷ already handled by your recent push

**Base:** synced to `main` @ b7e4842 (your "reliability + UX" + "edit/shell/verify" pushes folded in). Audits below were run on pre-merge v0.2.37, so file:line may have shifted (+179 in App.tsx); each is re-verified against the merged tree before fixing.

---

## ⚠ MORNING CHECKLIST (verify these by hand — I can't from here)
- [ ] Exit gearbox (fullscreen): terminal restores cleanly, no blank screenful, cursor visible, tab title reset. (viii)
- [ ] Scrolling feels smooth (wheel + PgUp/PgDn). (xi)
- [ ] Large paste in YOUR terminal (and tmux/ssh if you use them) collapses to a `[Pasted N]` chip, doesn't flood. (xii)
- [ ] `/usage` on the Claude subscription shows real 5h/7d %, not "ok". (xiii) — needs python3 + your authenticated claude config dir.
- [ ] Image attachment on a subscription works. (xiv)
- [ ] `/model opus` on a subscription stays on the subscription's opus seat (free), doesn't drop to metered API. (xv)
- [ ] "use opus to ..." actually runs opus (main turn AND any delegated sub-task). (xvi)
- [ ] During a long read / 90s delegate it visibly looks alive (elapsed counter / heartbeat). (iii)

---

## Why this is happening (root causes)
- **R1 — subscription path bypasses the routing seam.** The CLI/subscription pin lives in `activeCliRef` outside the selector; `SubscriptionPinSelector` exists but is never instantiated (dead). Every capability is built twice; the CLI side is the one consistently missing/broken. Source of: vi, xiv, xv, xvi(delegate), xiii, compaction-on-sub, delegate-on-sub, effort-on-claude, codex-resume, cli-session-persist.
- **R2 — no single source of truth.** Cost (3 accumulators), "what model ran" (3 refs), context window ("route a fresh model to read .contextWindow" in 3 places), tokens (3 numbers). Source of: ii, x, status/ledger/provenance disagreement, compaction-window.
- **R3 — uncontrolled retries + silent failures + under-parsed intent.** No `maxRetries` anywhere → 30s dead UI on a blip; "use opus" never parsed; failures silent (prefer-below-bar, probe→"ok", @mention punctuation, abandoned pre-clear session). Source of: vii, xvi, v, the "looks broken" UX.
- **R4 — App.tsx is a 3,700-line god-component with zero integration tests.** Pure layers are correct & tested; bugs live in App wiring + policy. No test covers turn lifecycle / live failover / busy-abort-offline / subprocess.

---

## Reported bugs (your 19)
- ☐ **i** no real end-of-turn summary (only when files changed). → emit a light recap every non-interrupted turn. *(group: liveness)*
- ☐ **ii** cost broken: session vs ledger diverge; delegation over-counts ledger / under-counts session; failed attempts dropped; subscription priced at metered; cache tokens ignored; discovered models = $0. *(SSOT)*
- ☐ **iii** looks dead on reads/delegate: no live elapsed on running lines; delegate sub-agents run with noop onEvent; mascot "tool" state has no animation. *(liveness)*
- ☐ **iv** ↑ history doesn't recall once you've typed (multi-line draft + no live-draft preservation; histIdx not reset on edit). *(input)*
- ☐ **v** /prefer no-op when pinned (setSelector keeps FixedSelector); also silently ignored when the model is below the kind's quality bar. *(routing/input)*
- ☐ **vi** /ask refuses on subscription (hard-wired to runCompletion/AI-SDK). → route via CLI seat. *(subscription)*
- ☐ **vii** offline failure leaves you stuck ~30s, no fast-fail (no maxRetries; offline probe cosmetic). *(network)*
- ⚠ **viii** blank screenful after exit: no SIGINT/SIGHUP restore; restore order wrong; title/cursor not reset. *(terminal)*
- ☑ **ix** status bar truncates "auto"→"a…" — FIXED: `fitStatusFields` sheds low-priority left fields by width, reserves the right side. (StatusBar.tsx + statusbar-layout.test) [v0.2.38]
- ☐ **x** /context shows 1M window on haiku: select({prompt:""}) routes to a 1M model unrelated to the turn. *(SSOT)*
- ⚠ **xi** scrolling jumpy: 1 line/notch + per-frame easing re-render + atBottom re-pin fighting manual scroll. *(terminal)*
- ☐ **xii** large paste floods: markerless-paste fallback too narrow (needs >240 chars AND newline AND single read). *(input)*
- ⚠ **xiii** usage shows "ok ok": real % probe only runs behind the statusPinned toggle, never at boot / inline; silent null fallback to seeded "ok". *(subscription)*
- ☐ **xiv** images refused on subscription: cli-backend has no image support; App hard-blocks. → pass image paths to CLI. *(subscription)*
- ☐ **xv** /model <name> leaves subscription for metered API (pin path ignores seats). *(subscription/routing)*
- ☐ **xvi** "use opus" ignored → ran sonnet (no NL model parser; delegation re-routes independently). *(routing)*
- ☑ **xvii** "took 1m 60s" — FIXED: round whole seconds before splitting; carry to minutes. (App.tsx formatDuration + duration.test) [v0.2.38]
- ☐ **xviii** /budget no-op for the common case (env-only providers get a neutral state that bypasses balanceOf; spend not keyed to provider). NOTE: your new `/cap` is a separate hard-ceiling feature, not this. *(SSOT)*
- ☐ **xix** clear+resume loads the empty post-clear session (listSessions sorts purely by updatedAt; /clear doesn't persist outgoing first). *(session)*

## Additional bugs found by the audit (~48)
### Routing
- ☐ R-1 status-bar model can disagree with what ran (failover + /ask don't set lastPick).
- ☐ R-2 /prefer below the quality bar silently ignored (preferredIn only searches `clears`).
- ☐ R-3 subscription seat for a non-native sdkId loses all profile data → can fail the quality bar and drop the subscription from candidacy.
- ☐ R-4 effort can hard-THROW mid-turn when routing picks a model lacking the active effort tier (should clamp).
- ☐ R-5 env-provider cooldown is provider-wide: one 402/quota on one model benches the whole provider for 5 min.
- ☐ R-6 classifier model chosen by pure cost (no quality floor) → nova-micro/flash-lite can misclassify, cached for 256 prompts.
- ☐ R-7 reason "$X/Mtok" is a made-up blend (in + 0.2·out), not a real rate, and diverges from estimateCost.
- ☐ R-8 `/model auto` on a subscription just clears the seat model (doesn't enable routing); confusing message.
- ☐ R-9 SubscriptionPinSelector is dead code; subscription pin bypasses the seam entirely (root R1).
### Subscription / CLI
- ☐ S-A auto-compact & /compact die on a subscription (modelSummarizer = raw AI SDK, no creds/CLI) → long chats overflow the window; bills API when it works.
- ☐ S-B delegate/delegate_parallel error out entirely on a subscription-only setup (no fallback).
- ☐ S-C codex `exec resume` argv malformed (`resume` after flags) → every codex turn starts fresh.
- ☐ S-D CLI session id never persisted → no real resume across restarts for subscription turns.
- ☐ S-E effort silently dropped for the claude CLI (only codex gets it), yet App validates/throws on it.
- ☐ S-F flat-rate CLI cost recorded as real metered spend (inflates ledger); codex falls back to estimateCost.
- ☐ S-G image ledger note only on API path (history divergence once xiv fixed).
- ☑ S-H /export and /copy DO work on subscription (no bug; noted).
### Cost / context
- ☐ C-A failed/retried attempts' tokens dropped from BOTH session and ledger (under-count).
- ☐ C-B estimateCost returns $0 for any model not in modelRegistry (discovered/gateway/seeded).
- ☐ C-C reason "$/Mtok" blend (dup of R-7).
- ☐ C-D strip shows two unrelated "context" numbers (cumulative `tokens` vs lastInput/ctxPct).
- ☐ C-E ctxPct ignores cache tokens → context % collapses on a cache hit.
- ☐ C-F auto-compact budget keys off a different model's window than the one answering.
### Session / input / paste
- ☐ I-A markerless paste split across reads still floods (per-read size check, no time-window coalescer).
- ☐ I-B unterminated bracketed paste freezes input (no timeout/escape).
- ☐ I-C typed @mention with trailing punctuation silently doesn't attach.
- ☐ I-D quitting never persists (only turn-end); exit()/⌃C-quit have no persist hook.
- ☐ I-E histIdx not reset on edit (edit a recalled entry then ↑ discards edits).
- ☐ I-F /resume <n> uses a stale snapshot (resumeListRef vs fresh sessions).
- ☐ I-G title truncation mismatch (80 vs 42 vs untruncated) — cosmetic.
- ☐ I-H paste chip store cleared globally on first submit.
### Lifecycle / errors / offline
- ☐ L-A verification can run after interrupt; post-turn test run not interruptible.
- ☐ L-B auto-compaction also hits the retry storm (extends dead window; no maxRetries).
- ☐ L-C type-ahead queue auto-fires next prompt into a still-broken state after an errored turn; no clear-queue.
- ☐ L-D busy can wedge if the finally's summary block throws (unhandled rejection from `void runTurn`).
- ☐ L-E single-`done` invariant fragile/untested (ask path vs failover vs CLI).
- ☐ L-F CLI subprocess abort = SIGTERM only, no SIGKILL escalation → wedged child pins busy forever (real permanent hang).
- ☑ L-G isNetworkError regex misses "Connect Timeout Error" — FIXED: added undici/AI-SDK shapes (connect timeout, attempted address, failed after N attempts). (net.ts + net.test) [v0.2.38]
- ☐ L-H linger timer not cleared on unmount.
- ☐ L-I network/timeout classified as "other" (terminal) not retryable; backwards vs rate-limit.
### Terminal / rendering
- ⚠ T-A OSC window title never reset on exit.
- ⚠ T-B cursor can be left hidden after a signal exit.
- ☐ T-C empty mouse-up over transcript can re-copy a stale selection.
- ☐ T-D drag-select during the scroll glide reads a stale scrollTop.
- ⚠ T-E footer height under-budgets the Working ghost rows → can clip status/composer during a turn.
- ☐ T-F scrollbar thumb can sit one row short of bottom (cosmetic).
- ☐ T-G Banner has the same truncate-end-no-budget latent bug as the status bar.

### Newly noted (post-merge)
- ☐ N-1 your transient-retry landed in `failover.ts`, which is DEAD CODE (not imported in App.tsx); the live path is the inline hop-loop. Decide: wire failover.ts live, or port transient retry into the inline loop. (I'll port the offline fast-fail into the live path now; leaving the "make failover.ts live" refactor for your call.)

---

## Execution order (safe-first, then structural, then live-only)
1. Terminal/pure quick wins: xvii, ix, T-G, L-G/L-H, formatDuration test.
2. Cost/SSOT: ii, x, xviii, C-A/B/D/E/F, R-7.
3. Network/liveness: vii, L-B/L-F/L-I, i, iii.
4. Input/session: iv, v, xii, xix, I-A..I-H.
5. Subscription parity (structural): vi, xiv, xv, xvi, S-A..S-F, R-9.
6. Live-only (implement + unit test + checklist): viii, xi, xiii, T-A/B/E.
7. Integration tests for the turn lifecycle.
