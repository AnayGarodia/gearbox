# Gearbox Context Engine & Model Routing Analysis

## CORRECTNESS ISSUES

### builder.ts
- **Line 341: Off-by-one risk in cacheBreak calculation**: `finalMessages.length - 2` assumes exactly one message (the user message) gets appended, but if `sanitizeToolPairs` drops both the last assistant message AND the user message (edge case: interrupted turn with unpaired tool_use), the index would be wrong. The calculation happens AFTER sanitize, which is correct, but the invariant (cacheBreak ∈ [−1, finalMessages.length-2]) is never asserted.
  
- **Line 155-189 (sanitizeToolPairs)**: The function filters tool-call/tool-result pairs bidirectionally, but the logic assumes tool_call toolCallId strings are stable and globally unique. If two different turns accidentally generate the same toolCallId, this breaks. No validation that IDs are unique per message sequence.

- **Line 192-239 (dedupeFileReads)**: When a file is read multiple times, the function keeps the LAST occurrence but marks earlier ones as elided. However:
  - It assumes `toolCallId` on a tool-result is sufficient to backtrack to the tool-call — if a tool-result's toolCallId is missing/null, `pathOf.get()` silently fails to match, leading to the stale read never being marked as duplicate.
  - Line 217: `{ type: "text", value: "..." }` assumes tool-result output can be replaced with a text object. If a provider uses a different structure for tool-result output, this breaks.

### retrieve.ts
- **Line 90 (updateRetrievalFile)**: When updating the index, if a file removal collides with its own re-add (e.g., fast edit, network lag), the removal deletes `idx.files` entry BEFORE the add recreates it, but `idx.n` count could fall out of sync if the subsequent add is skipped due to a condition (though the code guards against this). The invariant `idx.n === idx.files.length` is never asserted.

- **Line 151 (retrieveFiles)**: Files are skipped if `used + tokens > budget`, but there's no fallback — if ALL ranked files overflow the budget, the function returns EMPTY, losing potentially relevant small files that were ranked lower. A single huge file could exclude all others.

### repomap.ts
- **Line 30**: `listProjectFiles(cwd).filter((f) => CODE.test(f))` assumes `listProjectFiles` returns normalized paths, but if some paths use `\` (Windows) and others `/`, the regex `CODE` (checking suffixes) might still match, but the duplicate-removal logic (if any) in downstream code could fail.

- **Line 60-66 (sorting)**: In-degree is used as a tiebreaker, but the score calculation is deterministic only if all files have UNIQUE in-degree. When multiple files tie on in-degree AND alphabetical order, the sort is stable but depends on the input array order from `listProjectFiles`, which may not be deterministic across filesystems.

### memory.ts
- **Line 25 (slug function)**: `replace(/^-+|-+$/g, "")` removes leading/trailing dashes, but if the cwd is purely non-alphanumeric (e.g., `///`), this results in an empty string. The fallback `|| "root"` only applies after the first replace, not to the final result — a second replace could empty it again (though `||"root"` catches the final empty). Actually safe, but fragile.

- **Line 51 (loadFacts)**: Slices the file from the end if it exceeds FACTS_CAP. If the file ends in the middle of a fact line (e.g., `- [2025-01-15] fix the ...` is cut off), the next read produces invalid markdown. No validation that the returned text is well-formed.

---

## MISSING EDGE CASE HANDLING

### builder.ts
- **Line 106-109 (msgTokens)**: Assumes `content` is either a string or an array. If `content` is `null` or `undefined`, `textOf` will return `"null"` or `"undefined"`, adding tokens for the literal string. Should handle nullish content explicitly.

- **Line 119-123 (groupTurns)**: Assumes messages are well-formed and alternate user/assistant properly. If the history has consecutive user messages (possible after compaction or tool result dropout), the grouping still works but semantically meaningless — a tool result without a preceding tool call violates the protocol, but the grouper doesn't catch it.

- **Line 260-275 (buildContext, verification commands)**: Calls `detectVerificationCommands(cwd)` but doesn't validate that `cwd` exists or is readable. If `cwd` is a dead symlink or was deleted, the call silently fails (caught by `safe()` wrapper) and returns `[]`, losing the verification commands the model needs to check work. No warning.

- **Line 277-281**: `loadProjectMemory(cwd)` and subsequent retrieval calls also fail silently inside `safe()`. If a project has a GEARBOX.md with bad permissions or a corrupted file, the agent never learns about it. Users have no signal they're missing critical context.

### caching.ts
- **Line 64 (withPromptCaching)**: The cacheBreakIndex is clamped to `[−1, n−1]`, but:
  - If cacheBreakIndex is `undefined` and n === 0 (empty messages), breakAt becomes -1, which is never added to `out` because the loop never runs. The result is an empty messages array with no system marker — the wire format might be invalid.
  - Line 66: `messages[i]!` assumes `i < n`, but if n === 0 the loop doesn't run, hiding the edge case.

- **Line 75-82**: When merging providerOptions, the code assumes the existing `providerOptions` object keys don't collide with `mark` keys beyond a single provider. If a message already has `{ anthropic: {...} }` and we're marking for Anthropic, the shallow merge `{ ...prev[provider], ...opts }` is correct, but there's no validation that pre-existing options won't conflict (e.g., both trying to set cacheControl).

### router.ts
- **Line 145-170 (enumerate)**: The function creates a Candidate for each (model, account) pair. If an account is enabled but has `a.exec === "cli"` AND a provider doesn't have a corresponding seat in `subscriptionSeats()`, the account is silently missing from the pool. The logic assumes every enabled account either appears in modelRegistry() or subscriptionSeats(), but this isn't enforced.

- **Line 189**: When no capable model exists for a requirement, the error message shows the first 4 candidates and their missing features. But if `capable.length === 0` and `all.length > 4`, the message is incomplete, and users won't know about models further down the list.

- **Line 265-270 (escalation under empty clears)**: If escalation raises the bar above all models' quality AND all models have unknown quality (seeded profile, score 0.5), `clears` is re-populated with the top tier. But "top tier" is computed by `Math.max(...pool.map(qualityOf))`, which returns 0.5 for unknown. All models tie, so the tie-break (tps → quality → id) applies, making the pick deterministic but not necessarily the strongest. Should check if the top quality is `undefined` or seeded.

### scoring.ts
- **Line 118**: `scarcity = w.wScarcity * (costEst / Math.max(a.balanceRemainingUSD, 1e-6))` uses 1e-6 as a floor to avoid divide-by-zero. If balance is exactly 0, scarcity becomes `w * costEst / 1e-6 = w * costEst * 1e6`, a huge penalty. This is intentional (force away from exhausted accounts), but the weight `w.wScarcity` is not documented to account for this 1e6 amplification. If a user modifies weights without understanding, they could break the scoring scale.

- **Line 163-166**: When computing `latencyBonus` for interactive turns, `tps > 0 ? clamp(...) : 0.5` treats unknown tps (0) as mid-speed. But `TPS_REF = 150` is global and constant — if the model spec has `tps: 0` because it's a new model without measured data, penalizing it equally with a slow model (measured at 50 tps) is unfair. Should distinguish "unknown" from "measured slow".

### retrieve.ts
- **Line 145-154 (rankFiles)**: The query classification `asksModelSelection` (lines 132-134) uses hardcoded keywords. If a user asks "which model should I use for X", `model` is detected but `default` and `used` are both missing, so asksModelSelection is false, and the boost isn't applied. The logic is too strict (should be `||`, not `&&`). Also, `/(^|\/)(model\/selector|model\/router|config)\.ts$/` is a hardcoded path boost only for this repo's structure — fragile for other codebases.

---

## PERFORMANCE CONCERNS

### retrieve.ts
- **Line 30-100 (buildIndex)**: Reads every code file fully into memory (`raw.set(f, src)`). For a large monorepo (>1000 files), this is expensive upfront. The index is cached globally (`cached`), so subsequent calls are free, but:
  - The index grows unbounded in memory; `resetRetrievalIndex()` is called manually but users might not know to call it after large file deletions (RAM leak potential).
  - No parallelism or streaming; every file is read synchronously.

- **Line 115**: IDF calculation `Math.log(1 + (idx.n - d + 0.5) / (d + 0.5))` runs at query time, not index-build time. For 1000s of terms × 100s of files, this is repeated work. Precomputing IDFs at index-build time would save query latency.

### repomap.ts
- **Line 56-63 (sorting)**: Every file's in-degree is computed and stored, then files are sorted. If in-degree is stable, we could cache the sorted order and avoid re-sorting on subsequent calls to repoMap(). Currently, there's no caching of the rank order.

### builder.ts
- **Line 330 (dedupeFileReads)**: This function scans the entire history twice (once to build `pathOf` map, once to find last occurrence per path). For a long multi-turn session (100+ turns), this is O(n) but could be optimized to a single pass or cached.

- **Line 319-329 (history trimming loop)**: Trims turns one by one while checking if the total fits. Each iteration re-summing turn costs is inefficient. Should precompute cumulative costs and binary-search or track running total.

### context/git.ts
- **Lines 5-6 (git command wrapper)**: Every call to `git()` spawns a new process. `gitContext()` makes 6 git calls (`rev-parse`, `branch`, `status`, `diff --cached`, `diff`, `log`). For a large repo, these could be slow (especially `log` and `diff`). No timeout or cancellation signal.

---

## ABSTRACTION GAPS

### selector.ts vs. router.ts
- The `Task` interface lives in `selector.ts` but only `RoutingSelector` (in `router.ts`) actually uses the optional fields (`escalate`, `interactive`, `requires`). `FixedSelector` ignores them all. The interface is "future-proofed" but this creates an impedance mismatch: callers must know to fill in optional fields even though most selectors don't use them. Should split `Task` into a base and a `RoutingTask`.

### reasoning.ts
- **effortLevels()**: Returns `[]` for models without explicit effort levels AND without `spec.reasoning === true`. This conflates "no reasoning support" (should return `[]`) with "reasoning support but no effort control" (should return a default like `["medium"]`). If a model supports reasoning but doesn't advertise effort levels, the caller can't invoke reasoning.

### capabilities.ts
- **missingRequirements()**: When `r === "reasoningEffort"`, it only checks `caps.reasoningEffort === false`. But a model with `reasoningEffort: []` (supported but no levels) would pass, and then calling `reasoningOptions()` with an empty string would fail silently. The "reasoning effort is available" contract is broken.

### routing-context.ts
- **headroomOf()**: Filters windows that have reset (`r.resetsAt * 1000 < now`), but `resetsAt` is epoch SECONDS and `now` is milliseconds. The comparison should be `r.resetsAt * 1000` (correctly done), but there's no type safety — if `resetsAt` is already in ms or undefined, the arithmetic is wrong. Should use a strict type or a helper.

---

## MISSING TESTS

### Critical paths with no visible test files:
- **builder.ts**: `sanitizeToolPairs()` (line 155) — correctness is critical (tool pairing invariant); edge cases: unmatched IDs, empty content, multiple unmatched pairs in sequence.
- **builder.ts**: `dedupeFileReads()` (line 192) — edge cases: duplicate reads same file 3+ times, reads of non-existent paths, reads with missing toolCallId.
- **builder.ts**: `buildContext()` overall flow — the cacheBreak index calculation is tested only indirectly; off-by-one errors hide.
- **retrieve.ts**: `rankFiles()` and BM25 scoring — no visible tests for the ranking algorithm; quality regression possible.
- **repomap.ts**: `repoMap()` — no tests for tie-breaking behavior or budget exhaustion edge cases.
- **router.ts**: Escalation logic (line 224-227) — complex; edge cases: all models unknown quality, empty pool, tie-break order.
- **scoring.ts**: `scoreCandidate()` — unit tests could verify weight parameters and edge cases (balance=0, headroom=0, etc.).

---

## MISSING VALIDATION & ASSERTIONS

### builder.ts
- **No validation of cacheBreak invariant**: After `sanitizeToolPairs()` and before return, should assert `-1 <= cacheBreak < finalMessages.length`.
- **No validation that tool pairing is balanced**: After sanitization, should count and assert toolCallIds in tool-calls equal those in tool-results.

### retrieve.ts
- **No validation of index consistency**: After `updateRetrievalFile()`, should assert `idx.files.length === idx.n`.
- **No validation of ranking scores**: `rankFiles()` should assert all returned scores are > 0 (they're filtered, but scores could underflow to negative due to floating-point).

### caching.ts
- **No validation of output format**: `withPromptCaching()` assumes the message structure is valid for the provider; should validate that system and messages are compatible.

### router.ts
- **No validation of candidate pool invariants**: After `enumerate()`, could assert all candidates have valid backend configurations and non-null models.

---

## INCONSISTENT ERROR HANDLING

### builder.ts, repomap.ts, retrieve.ts
- All use `safe()` helper (line 346) to wrap fallible operations and silently return a fallback. This is safe (never crashes) but SILENT — if `loadProjectMemory()` or `repoMap()` fails, the agent never knows it's missing context. Should emit a warning or log the failure so users can debug.

### router.ts, selector.ts
- `FixedSelector.select()` (line 84-88) throws if no model is available. `RoutingSelector.select()` (line 227-231) throws with the same message. But `RoutingSelector.prepare()` can return `fallback: undefined` if the pool is empty AND no default is available. The two paths have slightly different error messages, causing inconsistency.

### cooldown.ts
- Cooldowns are in-memory only. If the process crashes, the cooldowns are lost and the next run might retry an exhausted account immediately. No persistence layer. This is intentional (ephemeral) but undocumented.

---

## INCOMPLETE DOCUMENTATION / UNCLEAR CONTRACTS

### builder.ts
- **cacheBreak field**: Documented as "the last SETTLED message" but the calculation (`finalMessages.length - 2`) is fragile. A clear formula or invariant statement would help.
- **dedupeFileReads contract**: Doesn't specify what happens if a file is read but never appears in `pathOf` (e.g., tool-result with missing toolCallId). Implicitly: it's not deduplicated.

### retrieve.ts
- **buildIndex contract**: Doesn't state memory usage or document that it's cached. A cache-size limit or LRU eviction policy is missing.
- **rankFiles contract**: The boost for "model selection" questions (line 145-148) is hardcoded and undocumented. Why `8 * idf`? Why only these paths?

### reasoning.ts
- **effortLevels contract unclear**: When does it return `[]` vs. a provider-specific list? If a model supports reasoning but the profile has no effort levels, does the caller invoke reasoning at all?

### scoring.ts
- **Weight meanings are implicit**: DEFAULT_WEIGHTS are set but not documented (e.g., what does `wScarcity: 1.0` mean in absolute terms? Is it a fraction of cost, or absolute USD?).
- **Tie-breaking order (line 152-156) is undocumented**: Why tps > quality > id? Stable but arbitrary.

### router.ts
- **Confidence-gating / escalation contract**: Line 224-227 climbs to the "strongest tier" when escalation clears nothing. What is "strongest"? Highest quality. But if quality is seeded (unknown), all models are equally strong. Should clarify the policy for unknown-quality ties under escalation.

---

## DATA-DRIVEN RISKS

### providers.ts
- **MODELS list is hand-curated and data-driven**: If a cost or contextWindow value is wrong, the router makes incorrect decisions (e.g., a 200k context model routed a 300k working set). There's no validation that specs match the provider's documented limits. Ideally, a validation script would cross-check against live API metadata (e.g., OpenAI's /models endpoint).

### profiles.ts
- **Quality scores (sweBenchVerified, intelligenceIndex) are seeded/researched, not all measured**: The provenance tags help, but routing trusts these values implicitly. If a score is stale or wrong, the router escalates/demoges inefficiently. No update cadence is specified.

### routing-context.ts
- **Balance staleness threshold (scarcityStaleMs = 15 minutes)**: Hardcoded. If a user's balance is stale but they haven't refreshed usage in 20 minutes, scarcity is 0 (ignored), and the router might route to an actually-exhausted account. The threshold isn't user-configurable.

---

## POTENTIAL BUGS IN EDGE CASES

### builder.ts, line 217
```typescript
return { ...p, output: { type: "text", value: "..." } };
```
Assumes `p.output` is reassignable and the new structure is accepted. If a tool result already has `output: { type: "json", value: {...} }`, replacing it with text changes the type. Some providers might expect consistency. Should preserve the type or use a wrapper.

### builder.ts, line 145-149
```typescript
if (p?.type === "tool-call") return JSON.stringify(p.input ?? p.args ?? {});
if (p?.type === "tool-result") return typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? p.result ?? "");
```
Tries both `p.input` and `p.args` for tool-call, but only for tool-call. Inconsistent with tool-result (`p.output` and `p.result`). If a provider uses different field names, tokenization breaks.

### retrieve.ts, line 147-148
```typescript
if (asksModelSelection && /(^|\/)(model\/selector|model\/router|config)\.ts$/.test(fl)) s += 8 * idf(idx, "model");
```
The regex `(^|\/)` matches the start of the path or a `/`. But file paths are already `/` delimited (from `listProjectFiles`), so `^` is redundant. The pattern should just be `(.*\/)?` or use simpler string matching. Also, this boost ONLY fires if BOTH `asksModelSelection` AND the regex match. If the user asks "what model is best", the files might not be selected without this boost, but the boost might not fire if keywords don't match exactly.

### router.ts, line 265
```typescript
const top = Math.max(...pool.map(qualityOf));
clears = pool.filter((c) => c.backend?.kind === "cli" || qualityOf(c) >= top - 1e-9);
```
Uses `top - 1e-9` to handle floating-point epsilon, but 1e-9 is arbitrary and tiny. If two models have quality 0.8 and 0.7999999999, they're both "top" due to epsilon. Should use a relative epsilon like `0.001`.

### scoring.ts, line 113
```typescript
if (fresh) scarcity = w.wScarcity * (costEst / Math.max(a.balanceRemainingUSD, 1e-6));
```
If cost is huge (e.g., 1000 USD) and balance is 0.01 USD, scarcity becomes `1.0 * 1000 / 1e-6 = 1e9`. The score then becomes dominated by scarcity, and all other terms are noise. This is intentional (force away from nearly-exhausted accounts) but the weight `wScarcity: 1.0` suggests it's on the same scale as `costEst`, which it's not. Documentation or clamping would help.

---

## POTENTIAL RACE CONDITIONS

### routing-context.ts
- **buildRoutingContext() reads usage asynchronously refreshed elsewhere**: If usage.json is being updated concurrently (by a background refresh), a stale read could happen. The function is marked "never a network call on the hot path" but if the usage file is deleted or corrupted during a read, the JSON parse fails and usage is silently dropped.

### retrieve.ts
- **updateRetrievalFile() modifies cached index**: If `retrieveFiles()` is called concurrently with `updateRetrievalFile()` (e.g., one turn is computing a response while another turn edits a file), the index could be inconsistent. No locking. The index is in-process only, so this is a Node.js event-loop issue, not OS threading, but still a problem if awaits are used carelessly.

---

## SUMMARY OF KEY FINDINGS

| Issue | File | Severity | Category |
|-------|------|----------|----------|
| cacheBreak off-by-one risk after sanitization | builder.ts:341 | HIGH | Correctness |
| dedupeFileReads misses nullish toolCallIds | builder.ts:217 | MEDIUM | Correctness |
| retrieveFiles returns empty on budget overflow | retrieve.ts:151 | MEDIUM | Correctness |
| asksModelSelection logic too strict (&&, not \|\|) | retrieve.ts:145 | MEDIUM | Correctness |
| withPromptCaching breaks on empty messages | caching.ts:64 | MEDIUM | Correctness |
| enumerate missing seats/accounts in pool | router.ts:145 | MEDIUM | Correctness |
| escalation fallback ignores unknown quality | router.ts:265 | LOW | Correctness |
| scarcity score unbounded (1e6 amplification) | scoring.ts:118 | MEDIUM | Correctness |
| No tests for critical path functions | various | HIGH | Testing |
| Silent failures in safe() wrapper | builder.ts:346 | MEDIUM | Error Handling |
| BM25 IDF recalculated per query | retrieve.ts:115 | LOW | Performance |
| History trim loop re-sums costs | builder.ts:319 | LOW | Performance |
| git commands not parallelized (6 spawns) | git.ts:5 | LOW | Performance |
| Task interface unused fields (Future coupling) | selector.ts | LOW | Architecture |
| Undocumented weight meanings | scoring.ts | MEDIUM | Documentation |
| Hardcoded staleness thresholds | routing-context.ts | LOW | Configuration |

---

## RECOMMENDED PRIORITIES

1. **Add test suite for critical paths**: sanitizeToolPairs, dedupeFileReads, buildContext flow, rankFiles, scoreCandidate (HIGH impact)
2. **Fix asksModelSelection keyword detection** (line 145): Change `&&` to `||` (QUICK FIX)
3. **Add cacheBreak invariant assertion** (line 341): Validate -1 <= cacheBreak < finalMessages.length (QUICK FIX)
4. **Document weight meanings and staleness thresholds** (scoring.ts, routing-context.ts) (LOW effort, high clarity)
5. **Precompute IDF at index-build time** (retrieve.ts:115) (MEDIUM effort, improves query latency)
6. **Replace silent safe() failures with warnings** (builder.ts:346) (MEDIUM effort, improves debuggability)
7. **Add index consistency validation** (retrieve.ts, routing-context.ts) (LOW effort, catches bugs early)
8. **Document and formalize tie-breaking logic** (scoring.ts:152, retrieve.ts:60) (MEDIUM effort, reduces surprises)
