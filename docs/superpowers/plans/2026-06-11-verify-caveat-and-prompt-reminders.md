# Verify Caveat + System Prompt Reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a post-autofix overfitting caveat notice to VERIFY, and inject a compact system-prompt reminder into long sessions to counter instruction fade.

**Architecture:** Fix 1 adds `buildAutofixCaveat()` to `verify.ts` (pure helper, testable) and calls it in App.tsx's turn-settle block. Fix 2 adds `buildReminderBlock()` + `injectReminder()` to `builder.ts` and threads `verifyMode` from App.tsx into `buildContext`.

**Tech Stack:** TypeScript, Bun test, Ink (React for terminals)

---

### Task 1: Add `buildAutofixCaveat` to verify.ts

**Files:**
- Modify: `src/verify.ts` (append at end of file)
- Modify: `test/verify-autofix.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `test/verify-autofix.test.ts` after the existing `buildFixPrompt` describe block:

```typescript
import { shouldAutoFix, buildFixPrompt, buildAutofixCaveat, MAX_AUTOFIX_ATTEMPTS } from "../src/verify.ts";

// ... existing tests ...

describe("buildAutofixCaveat", () => {
  test("returns null on the original turn (attempt 0)", () => {
    expect(buildAutofixCaveat(0, [], ["src/a.ts"])).toBeNull();
  });

  test("returns null when checks still failing", () => {
    expect(buildAutofixCaveat(1, ["test: 2 failing"], ["src/a.ts"])).toBeNull();
  });

  test("returns null when no files changed", () => {
    expect(buildAutofixCaveat(1, [], [])).toBeNull();
  });

  test("returns caveat string when autofix succeeded", () => {
    const c = buildAutofixCaveat(1, [], ["src/a.ts"]);
    expect(c).not.toBeNull();
    expect(c).toContain("tests confirm structure");
    expect(c).toContain("1 autofix attempt");
  });

  test("pluralizes correctly for multiple attempts", () => {
    expect(buildAutofixCaveat(2, [], ["src/a.ts"])).toContain("2 autofix attempts");
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test test/verify-autofix.test.ts
```

Expected: FAIL — `buildAutofixCaveat is not a function`

- [ ] **Step 3: Add `buildAutofixCaveat` to src/verify.ts**

Append at the very end of `src/verify.ts`:

```typescript
/** When an auto-iterate-to-green pass succeeds (attempt > 0, all checks
 *  green, files were changed), return a caveat notice reminding the user
 *  that passing tests confirm structure, not semantic correctness.
 *  Returns null for original-turn passes (attempt === 0) or when nothing
 *  actually changed — both have lower overfitting risk. */
export function buildAutofixCaveat(
  attempt: number,
  failed: string[],
  changed: string[],
): string | null {
  if (attempt === 0 || failed.length > 0 || changed.length === 0) return null;
  const s = attempt === 1 ? "" : "s";
  return `✓ checks pass after ${attempt} autofix attempt${s} — tests confirm structure, not semantic correctness; review the diff`;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
bun test test/verify-autofix.test.ts
```

Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/verify.ts test/verify-autofix.test.ts
git commit -m "feat(verify): add buildAutofixCaveat helper for overfitting notice"
```

---

### Task 2: Wire the caveat notice into App.tsx

**Files:**
- Modify: `src/ui/App.tsx` (two changes: import + settle block)

- [ ] **Step 1: Update the verify import in App.tsx**

On line 71, change:

```typescript
import { detectVerificationCommands, runVerification, nextStepFor, shouldAutoFix, buildFixPrompt, provenTier, shouldOfferCharTest, buildCharTestPrompt, MAX_AUTOFIX_ATTEMPTS, type VerifyMode } from "../verify.ts";
```

to:

```typescript
import { detectVerificationCommands, runVerification, nextStepFor, shouldAutoFix, buildFixPrompt, buildAutofixCaveat, provenTier, shouldOfferCharTest, buildCharTestPrompt, MAX_AUTOFIX_ATTEMPTS, type VerifyMode } from "../verify.ts";
```

- [ ] **Step 2: Add the caveat branch in the autofix settle block**

Find the autofix settle block around line 2963 — it currently reads:

```typescript
          if (shouldAutoFix({ mode: verifyRef.current, attempt, failures: failed, changedFiles: changed })) {
            notice(`checks failed — fixing (attempt ${attempt + 1}/${MAX_AUTOFIX_ATTEMPTS})`);
            const fixPrompt = buildFixPrompt(failed);
            setTimeout(() => void runTurnRef.current?.(fixPrompt, attempt + 1), 0);
          } else if (verifyRef.current === "auto" && attempt >= MAX_AUTOFIX_ATTEMPTS && failed.length) {
            notice(`still failing after ${MAX_AUTOFIX_ATTEMPTS} fix attempts — over to you`);
          }
```

Change to:

```typescript
          if (shouldAutoFix({ mode: verifyRef.current, attempt, failures: failed, changedFiles: changed })) {
            notice(`checks failed — fixing (attempt ${attempt + 1}/${MAX_AUTOFIX_ATTEMPTS})`);
            const fixPrompt = buildFixPrompt(failed);
            setTimeout(() => void runTurnRef.current?.(fixPrompt, attempt + 1), 0);
          } else if (verifyRef.current === "auto" && attempt >= MAX_AUTOFIX_ATTEMPTS && failed.length) {
            notice(`still failing after ${MAX_AUTOFIX_ATTEMPTS} fix attempts — over to you`);
          } else {
            const caveat = buildAutofixCaveat(attempt, failed, changed);
            if (caveat) notice(caveat);
          }
```

- [ ] **Step 3: Run typecheck to confirm no errors**

```bash
bun run typecheck
```

Expected: no errors

- [ ] **Step 4: Run full test suite**

```bash
bun test
```

Expected: all existing tests still pass

- [ ] **Step 5: Commit**

```bash
git add src/ui/App.tsx
git commit -m "feat(app): surface autofix-overfitting caveat notice after iterate-to-green"
```

---

### Task 3: Add reminder helpers to builder.ts

**Files:**
- Modify: `src/context/builder.ts` (four changes: import, constant, two helpers, injection)
- Modify: `test/context.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `test/context.test.ts` — append after the last existing test, before `afterAll`:

First update the import on line 8 to include `buildReminderBlock`:
```typescript
import { buildContext, buildReminderBlock, sanitizeToolPairs, dedupeFileReads, distillToolCalls, elideTurn, capToolResults, recentlyReadPaths } from "../src/context/builder.ts";
```

Then add the tests (append before the existing `afterAll(() => resetRetrievalIndex())`):

```typescript
// ── system prompt reminders ──
function makeHistory(turnCount: number): ModelMessage[] {
  const h: ModelMessage[] = [];
  for (let i = 0; i < turnCount; i++) {
    h.push({ role: "user", content: `question ${i}` });
    h.push({ role: "assistant", content: `answer ${i}` });
  }
  return h;
}

test("buildReminderBlock returns plan-mode reminder when plan=true", () => {
  const r = buildReminderBlock(true, "auto");
  expect(r).toContain("plan (read-only)");
  expect(r).toContain("do not modify files");
});

test("buildReminderBlock returns normal-mode reminder with tier hint", () => {
  const r = buildReminderBlock(false, "auto");
  expect(r).toContain("mode: normal");
  expect(r).toContain("tests > types > none");
});

test("buildReminderBlock notes verify-off when disabled", () => {
  const r = buildReminderBlock(false, "off");
  expect(r).toContain("verify is off");
});

test("short sessions (<8 turns) do not inject a reminder", () => {
  const history = makeHistory(4);
  const { messages } = buildContext({ history, userText: "do something", model: sonnet, verifyMode: "auto" });
  const last = messages[messages.length - 1]!;
  const text = userMsgText(last);
  expect(text).not.toContain("mode: normal");
});

test("long sessions (>=8 turns) inject reminder into last user message", () => {
  const history = makeHistory(9);
  const { messages } = buildContext({ history, userText: "do something", model: sonnet, verifyMode: "auto" });
  const last = messages[messages.length - 1]!;
  const text = userMsgText(last);
  expect(text).toContain("mode: normal");
  expect(text).toContain("do something"); // original prompt survives
});

test("reminder in long sessions reflects plan mode", () => {
  const history = makeHistory(9);
  const { messages } = buildContext({ history, userText: "plan this", model: sonnet, plan: true, verifyMode: "auto" });
  const last = messages[messages.length - 1]!;
  expect(userMsgText(last)).toContain("plan (read-only)");
});

test("no verifyMode provided defaults to auto hint", () => {
  const history = makeHistory(9);
  const { messages } = buildContext({ history, userText: "x", model: sonnet });
  const text = userMsgText(messages[messages.length - 1]!);
  expect(text).toContain("tests > types > none");
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test test/context.test.ts 2>&1 | grep -E "FAIL|buildReminderBlock|verifyMode"
```

Expected: FAIL — `buildReminderBlock is not exported` and `verifyMode` unknown property

- [ ] **Step 3: Update the verify.ts import in builder.ts**

On line 44, change:

```typescript
import { detectVerificationCommands } from "../verify.ts";
```

to:

```typescript
import { detectVerificationCommands, type VerifyMode } from "../verify.ts";
```

- [ ] **Step 4: Add the REMINDER_TURN_THRESHOLD constant**

After `const TIGHT_TOOL_RESULT_CAP = 1_500;` (around line 131), add:

```typescript
// Sessions longer than this turn count get a compact reminder block injected
// into the last user message to counter instruction fade-out in long sessions.
const REMINDER_TURN_THRESHOLD = 8;
```

- [ ] **Step 5: Add buildReminderBlock and injectReminder before buildContext**

Add these two functions immediately before the `export function buildContext` declaration (around line 456):

```typescript
/** Returns a ~20-token reminder block reflecting the current mode and verify
 *  setting. Injected into long sessions to counter instruction fade-out. */
export function buildReminderBlock(plan: boolean, verifyMode: VerifyMode): string {
  if (plan) return "[mode: plan (read-only) — investigate only, do not modify files]";
  const hint = verifyMode === "auto"
    ? "after edits state which tier passed (tests > types > none)"
    : "verify is off";
  return `[mode: normal | verify: ${verifyMode} — ${hint}]`;
}

function injectReminder(msg: ModelMessage, reminder: string): ModelMessage {
  if (typeof msg.content === "string") {
    return { ...msg, content: `${msg.content}\n\n${reminder}` };
  }
  if (Array.isArray(msg.content)) {
    const parts = msg.content as any[];
    let lastTextIdx = -1;
    for (let i = parts.length - 1; i >= 0; i--) {
      if ((parts[i] as any)?.type === "text") { lastTextIdx = i; break; }
    }
    if (lastTextIdx >= 0) {
      const newParts = [...parts];
      newParts[lastTextIdx] = { ...parts[lastTextIdx] as object, text: `${(parts[lastTextIdx] as any).text}\n\n${reminder}` };
      return { ...msg, content: newParts as any };
    }
    return { ...msg, content: [...parts, { type: "text" as const, text: reminder }] as any };
  }
  return msg;
}
```

- [ ] **Step 6: Add verifyMode to buildContext opts and inject reminder**

In `buildContext`'s opts interface, add `verifyMode?: VerifyMode` after `plan?: boolean`:

```typescript
export function buildContext(opts: {
  history: ModelMessage[];
  userText: string;
  userContent?: any;
  model: ModelSpec;
  plan?: boolean;
  verifyMode?: VerifyMode;
  cwd?: string;
  recentTurns?: number;
}): BuiltContext {
```

After `const finalMessages = sanitizeToolPairs([...flat, userMsg]);` (line ~648), add:

```typescript
  if (Math.floor(history.length / 2) >= REMINDER_TURN_THRESHOLD) {
    const last = finalMessages[finalMessages.length - 1];
    if (last?.role === "user") {
      finalMessages[finalMessages.length - 1] = injectReminder(
        last,
        buildReminderBlock(Boolean(plan), opts.verifyMode ?? "auto"),
      );
    }
  }
```

- [ ] **Step 7: Run context tests**

```bash
bun test test/context.test.ts
```

Expected: all PASS including the 7 new reminder tests

- [ ] **Step 8: Commit**

```bash
git add src/context/builder.ts test/context.test.ts
git commit -m "feat(context): inject reminder block in long sessions to counter instruction fade"
```

---

### Task 4: Thread verifyMode from App.tsx into buildContext

**Files:**
- Modify: `src/ui/App.tsx` (one line change)

- [ ] **Step 1: Add verifyMode to the buildContext call**

On line 2137, change:

```typescript
        let { system, messages: ctx, cacheBreak, sections } = buildContext({ history: messages, userText: prompt, userContent, model: choice.model, plan, cwd: rootRef.current });
```

to:

```typescript
        let { system, messages: ctx, cacheBreak, sections } = buildContext({ history: messages, userText: prompt, userContent, model: choice.model, plan, verifyMode: verifyRef.current, cwd: rootRef.current });
```

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```

Expected: no errors

- [ ] **Step 3: Run full test suite**

```bash
bun test
```

Expected: all tests pass

- [ ] **Step 4: Commit**

```bash
git add src/ui/App.tsx
git commit -m "feat(app): thread verifyMode into buildContext for accurate session reminders"
```
