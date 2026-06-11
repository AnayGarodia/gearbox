# Verify Caveat + System Prompt Reminders

**Date:** 2026-06-11
**Scope:** Two correctness fixes identified by deep-research audit.

---

## Fix 1: VERIFY auto-iterate overfitting caveat

### Problem

The auto-iterate-to-green loop feeds failures back to the model and re-runs checks (≤3 attempts). When it succeeds, nothing signals to the user that "green tests ≠ semantic correctness" — the result looks identical to a turn that passed on the first attempt. This is the documented test-oracle overfitting failure mode (arXiv 2511.16858).

### Solution

In `src/ui/App.tsx`, after the turn settles, detect the condition:

- `attempt > 0` — this was an autofix pass, not the original turn
- `failed.length === 0` — checks passed
- `changed.length > 0` — files were edited

Push a `notice` item: `"✓ checks pass after {attempt} autofix attempt(s) — tests confirm structure, not semantic correctness. Review the diff."`

Only fires after an autofix pass, never after a clean first-attempt pass (the user's own tests ran cleanly — lower risk, no caveat needed).

### Files

- `src/ui/App.tsx` — add the notice push in the post-turn settle block (around line 2963), in the `else` branch where `shouldAutoFix` returns false and `failed.length === 0` and `attempt > 0`.

### No new exports required from verify.ts.

---

## Fix 2: System prompt reminders for long sessions

### Problem

`context/builder.ts` assembles the system prompt once at session start. In long sessions (many turns), instruction fade causes the model to progressively under-weight early system instructions — e.g. forgetting the current mode, or that it should state the proof tier after edits. This is empirically documented across 18 frontier models.

### Solution

In `buildContext`, when the session exceeds `REMINDER_TURN_THRESHOLD = 8` turns, append a compact reminder block to the text content of the last user message. This is the `<system-reminder>` injection pattern used by Claude Code itself — rides the existing user message, costs ~20 tokens, no extra API call.

The reminder content is dynamic: reflects the current `plan` flag (mode) and `verifyMode`.

**Format:**
```
[mode: normal | verify: auto — after edits state which tier passed (tests > types > none)]
```
```
[mode: plan (read-only) — investigate only, do not modify files]
```

Turn count is estimated from `history.length` (each turn ≈ 2 messages; use `Math.floor(history.length / 2)`).

Appending to the last user message: the last entry in `finalMessages` is always the current user message. Its `content` may be a string or an array of parts. Append to the string, or find the last `{ type: "text" }` part in the array and append to its `text` field. If the array has no text part, push one.

### New param

Add `verifyMode?: VerifyMode` to the `buildContext` opts interface. Thread `verifyRef.current` from App.tsx into the `buildContext` call at line 2137.

### Files

- `src/context/builder.ts` — add `REMINDER_TURN_THRESHOLD`, `buildReminderBlock(plan, verifyMode)`, append logic at end of `buildContext`
- `src/ui/App.tsx` — thread `verifyMode: verifyRef.current` into the `buildContext` call

---

## Out of scope

- MCP button, usage panel (deferred to a separate pass)
- Plan mode schema enforcement (already correct — `run.ts:330` passes `readOnly: Boolean(plan)` to `createToolset`)
- No changes to StatusStrip
