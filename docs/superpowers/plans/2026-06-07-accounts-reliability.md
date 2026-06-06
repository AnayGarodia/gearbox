# Accounts Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every subscription, API key, and cloud credential work reliably — auto-failover across accounts that serve the same model, clear failures with one-step re-login, stable name-based references (no numbers), and paste-anything credential ingestion.

**Architecture:** All work lives in the account resolution + execution layer between the `ModelSelector` (which picks the model) and the provider SDK call. The selector seam is untouched. New pure modules (`health.ts`, `sniff.ts`, model-family equivalence) are TDD-tested in isolation; the failover loop wraps `runTask`; the UI wires badges, the boot sweep, failover phase lines, and re-login.

**Tech Stack:** Bun + TypeScript + TSX, Ink for UI, Vercel AI SDK for model calls, `bun test` for tests.

**Phases (each ships working software):**
1. Identity — names only, stable unique slugs, numbers removed
2. Health — `classifyError` (pure) + `checkHealth` + cache + badges + touchpoint sweeps
3. Failover — model-keyed pool ranking + structured run failures + failover loop + clear errors + re-login
4. Universal ingestion — `sniffCredential` (pure) + add routing + real `testAccount` coverage

**Conventions for the executor:**
- Run tests with `bun test <file>` for one file, `bun test` for all. `bun run typecheck` runs `tsc --noEmit`.
- Tests live in `test/` mirroring the source name (e.g. `test/health.test.ts`).
- Commit after each task with the message shown. Branch is `worktree-accounts-reliability`.
- Never call `anthropic('claude-...')` outside `providers.ts` — route through the selector/resolver (CLAUDE.md).

---

## Phase 1 — Identity: names only, stable slugs

Removes positional numbers (the `/account 3` bug) and guarantees each account has a stable, unique slug used for switching.

### Task 1.1: Unique slug on add

The slug is what the user types (`/account claude-work`). `accountSlug()` in `commands.ts` derives it from the account, but two accounts can derive the same slug. Make the store guarantee uniqueness at add time by storing an explicit `slug` and de-duping.

**Files:**
- Modify: `src/accounts/types.ts` (add `slug` to `Account`)
- Modify: `src/accounts/store.ts` (`putAccount` assigns a unique slug; add `accountBySlug`)
- Modify: `src/commands.ts` (`accountSlug` prefers `a.slug` when present)
- Test: `test/account-slug.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/account-slug.test.ts
import { test, expect } from "bun:test";
import { uniqueSlug } from "../src/accounts/store.ts";

test("uniqueSlug returns the base when free", () => {
  expect(uniqueSlug("claude", [])).toBe("claude");
});

test("uniqueSlug suffixes on collision", () => {
  expect(uniqueSlug("claude", ["claude"])).toBe("claude-2");
  expect(uniqueSlug("claude", ["claude", "claude-2"])).toBe("claude-3");
});

test("uniqueSlug normalizes to kebab", () => {
  expect(uniqueSlug("Claude (Work)", [])).toBe("claude-work");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/account-slug.test.ts`
Expected: FAIL — `uniqueSlug` is not exported.

- [ ] **Step 3: Implement `uniqueSlug` and wire it into `putAccount`**

Add to `src/accounts/types.ts` in the `Account` interface (after `id`):

```ts
  slug?: string; // stable human reference for /account <slug>; unique across accounts
```

Add to `src/accounts/store.ts`:

```ts
/** Normalize a label/id to a kebab slug, suffixing -2, -3… to avoid collisions. */
export function uniqueSlug(base: string, taken: string[]): string {
  const norm = base.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "account";
  if (!taken.includes(norm)) return norm;
  for (let n = 2; ; n++) {
    const cand = `${norm}-${n}`;
    if (!taken.includes(cand)) return cand;
  }
}

export function accountBySlug(slug: string): Account | undefined {
  const s = slug.trim().toLowerCase();
  return listAccounts().find((a) => (a.slug ?? "") === s);
}
```

In `putAccount`, assign a slug when one isn't already set (so re-`putAccount` of the same id keeps its slug). Replace the body's start:

```ts
export function putAccount(account: Account): void {
  const f = loadAccounts();
  const i = f.accounts.findIndex((a) => a.id === account.id);
  if (!account.slug) {
    const taken = f.accounts.filter((a) => a.id !== account.id).map((a) => a.slug ?? "").filter(Boolean);
    // Prefer the existing slug for this id (stable across edits); else derive one.
    account.slug = (i >= 0 && f.accounts[i]!.slug) || uniqueSlug(deriveSlugBase(account), taken);
  }
  if (i >= 0) f.accounts[i] = account;
  else f.accounts.push(account);
  if (!f.defaults[account.provider]) f.defaults[account.provider] = account.id;
  saveAccounts(f);
}

// Base for a slug: the named part of a CLI account (claude-work), else provider.
function deriveSlugBase(a: Account): string {
  const named = a.id.match(/-cli-(.+)$/) || a.id.match(/^(?:azure-foundry|azure)-(.+)$/);
  if (named) return `${a.provider.replace(/-cli$/, "")}-${named[1]}`;
  return a.provider.replace(/-cli$/, "");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/account-slug.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Point `accountSlug` at the stored slug**

In `src/commands.ts`, change `accountSlug` to prefer the stored slug:

```ts
export function accountSlug(a: { id: string; provider: string; exec: string; auth?: any; slug?: string }): string {
  if (a.slug) return a.slug;
  return accountName(a)
    // (keep the existing fallback derivation below unchanged)
```

- [ ] **Step 6: Run the full suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/accounts/types.ts src/accounts/store.ts src/commands.ts test/account-slug.test.ts
git commit -m "feat(accounts): stable unique slug per account"
```

### Task 1.2: Remove positional numbers from switching and display

**Files:**
- Modify: `src/ui/App.tsx` (the `/account` parser: drop `byNumber` and the numeric branch)
- Modify: `src/commands.ts` (`formatAccounts`: drop the `(or N)` suffix)
- Modify: `src/ui/App.tsx` `buildAccountView` + `src/ui/types.ts` `AccountRow` (drop `number`)
- Modify: `src/ui/components` renderer that prints `AccountRow` (drop the number column)
- Test: `test/format-accounts.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/format-accounts.test.ts
import { test, expect } from "bun:test";
import { formatAccounts } from "../src/commands.ts";

const acct = (over: any) => ({ id: "anthropic-x", label: "Anthropic", provider: "anthropic", exec: "in-loop", slug: "anthropic", ...over });

test("formatAccounts uses slugs, never numbers", () => {
  const out = formatAccounts([acct({}), acct({ id: "anthropic-y", slug: "anthropic-2" })], null, []);
  expect(out).toContain("/account anthropic");
  expect(out).not.toMatch(/\(or \d+\)/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/format-accounts.test.ts`
Expected: FAIL — output still contains `(or 1)`.

- [ ] **Step 3: Remove the number from `formatAccounts`**

In `src/commands.ts`, change the per-row switch line (currently `use /account ${alias}${i + 1 ? ... (or ${i+1}) ...}`) to:

```ts
      lines.push(`      use /account ${alias}`);
```

And update the footer line to drop "number":

```ts
    "  switch: /account <name>",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/format-accounts.test.ts`
Expected: PASS.

- [ ] **Step 5: Remove numeric switching from the `/account` parser**

In `src/ui/App.tsx` `case "account"`, delete the `byNumber` helper, the `if (numbered) { activate(numbered); return; }` block, and the `if (/^\d+$/.test(subL))` out-of-range branch. After removal, a bare token that isn't a subcommand falls straight through to the existing `findAccountRef(arg, all)` name match (which already errors helpfully). Keep `off/add/remove/rm/import` handling intact.

- [ ] **Step 6: Drop `number` from `AccountRow` and `buildAccountView`**

In `src/ui/types.ts` remove `number: number;` from `AccountRow`. In `src/ui/App.tsx` `buildAccountView`, remove `number: i + 1,` from the row object. Find the component rendering `AccountView.rows` (grep `view.rows` under `src/ui/components`) and remove any `{r.number}` column; show `r.alias` as the switch hint instead.

- [ ] **Step 7: Run the full suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: all pass. Fix any reference to `.number` the typecheck flags.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(accounts): switch by name only, remove positional numbers"
```

---

## Phase 2 — Health: classify, check, cache, show

### Task 2.1: `classifyError` (pure)

The core that turns a raw provider error into a known state, driving both the badge and (Phase 3) the failover decision.

**Files:**
- Create: `src/accounts/health.ts`
- Test: `test/health-classify.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/health-classify.test.ts
import { test, expect } from "bun:test";
import { classifyError } from "../src/accounts/health.ts";

test("401 / invalid key → invalid", () => {
  expect(classifyError("anthropic", { statusCode: 401, message: "invalid x-api-key" })).toBe("invalid");
  expect(classifyError("openai", { message: "Incorrect API key provided" })).toBe("invalid");
});

test("expired token / not logged in → expired", () => {
  expect(classifyError("claude-cli", { message: "not logged in" })).toBe("expired");
  expect(classifyError("codex-cli", { message: "token expired, please re-authenticate" })).toBe("expired");
});

test("429 / rate limit / overloaded → rate-limited", () => {
  expect(classifyError("anthropic", { statusCode: 429, message: "rate limit" })).toBe("rate-limited");
  expect(classifyError("anthropic", { message: "Overloaded" })).toBe("rate-limited");
});

test("credit / quota / billing → no-credit", () => {
  expect(classifyError("anthropic", { message: "Your credit balance is too low" })).toBe("no-credit");
  expect(classifyError("openai", { message: "insufficient_quota" })).toBe("no-credit");
});

test("network / 500 / unknown → real-error (not credential-class)", () => {
  expect(classifyError("anthropic", { statusCode: 503, message: "upstream error" })).toBe("real-error");
  expect(classifyError("anthropic", { message: "fetch failed" })).toBe("real-error");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/health-classify.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `health.ts` (types + classifyError)**

```ts
// src/accounts/health.ts
// Account health: classify a provider error into a known state (pure, tested),
// and probe/cache an account's current health. Drives the /account badges and
// the failover decision (src/agent/failover.ts). No background polling.
import type { Account } from "./types.ts";

// "real-error" is the sentinel for "not a credential problem" — the failover
// loop must NOT advance the pool on it (network blip, model bug, 500).
export type HealthState = "ok" | "expired" | "invalid" | "no-credit" | "rate-limited" | "unknown" | "real-error";

export interface AccountHealth {
  state: HealthState;
  checkedAt: number;
  detail?: string;
}

// Credential-class states are the only ones that trigger failover.
export function isCredentialFailure(s: HealthState): boolean {
  return s === "expired" || s === "invalid" || s === "no-credit" || s === "rate-limited";
}

function statusOf(err: any): number | undefined {
  return err?.statusCode ?? err?.status ?? err?.response?.status ?? err?.data?.error?.status;
}
function textOf(err: any): string {
  return String(err?.message ?? err?.error?.message ?? err?.responseBody ?? err?.error ?? err ?? "").toLowerCase();
}

/** Map a provider error (HTTP/SDK/CLI) to a health state. Pure. */
export function classifyError(_provider: string, err: unknown): HealthState {
  const status = statusOf(err);
  const t = textOf(err);

  // no-credit before rate-limit/invalid: billing messages sometimes ride a 429/403.
  if (/credit balance|insufficient_quota|insufficient funds|billing|payment|quota exceeded/.test(t)) return "no-credit";
  if (/not logged in|not signed in|re-?authenticate|token (?:has )?expired|expired|session expired|login required|refresh token/.test(t)) return "expired";
  if (status === 429 || /rate.?limit|too many requests|overloaded|capacity/.test(t)) return "rate-limited";
  if (status === 401 || status === 403 || /invalid.*(api.?key|x-api-key|credential|token)|incorrect api key|unauthorized|authentication.?fail|permission denied/.test(t)) return "invalid";
  return "real-error";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/health-classify.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/accounts/health.ts test/health-classify.test.ts
git commit -m "feat(accounts): classifyError — provider error → health state"
```

### Task 2.2: Health cache + `checkHealth`

**Files:**
- Modify: `src/accounts/types.ts` (`Account.health?: AccountHealth`)
- Modify: `src/accounts/health.ts` (cache read/write + `checkHealth` + `recordHealth`)
- Modify: `src/accounts/store.ts` (persist health via `putAccount`; expose a TTL helper)
- Test: `test/health-cache.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/health-cache.test.ts
import { test, expect } from "bun:test";
import { isFresh } from "../src/accounts/health.ts";

test("isFresh true within TTL, false beyond", () => {
  const now = 1_000_000;
  expect(isFresh({ state: "ok", checkedAt: now - 60_000 }, now)).toBe(true);   // 1m old
  expect(isFresh({ state: "ok", checkedAt: now - 10 * 60_000 }, now)).toBe(false); // 10m old
  expect(isFresh(undefined, now)).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/health-cache.test.ts`
Expected: FAIL — `isFresh` not exported.

- [ ] **Step 3: Implement cache + check helpers**

Add `health?: AccountHealth;` to `Account` in `src/accounts/types.ts` (import the type or inline-reference it; `AccountHealth` lives in `health.ts`, so `types.ts` should define `AccountHealth`/`HealthState` and `health.ts` should import from `types.ts` to avoid a cycle — move the two type declarations into `types.ts` and re-export from `health.ts`).

Concretely: move `HealthState` and `AccountHealth` definitions to `src/accounts/types.ts`, and in `health.ts` add `import type { Account, AccountHealth, HealthState } from "./types.ts";` and `export type { AccountHealth, HealthState } from "./types.ts";`.

Add to `src/accounts/health.ts`:

```ts
export const HEALTH_TTL_MS = 5 * 60_000;

export function isFresh(h: AccountHealth | undefined, now: number): boolean {
  return !!h && now - h.checkedAt < HEALTH_TTL_MS;
}

/** Persist a freshly observed state for an account (called on success/failure). */
export function recordHealth(account: Account, state: HealthState, detail?: string): void {
  // putAccount keeps the existing slug; we only update the health field.
  const at = Date.now();
  putAccount({ ...account, health: { state, checkedAt: at, detail } });
}

/** Live probe of an account's credential. Cheap, no model generation.
 *  Reuses testAccount's connectivity checks; maps the result to a state. */
export async function checkHealth(account: Account): Promise<AccountHealth> {
  const at = Date.now();
  try {
    if (account.exec === "cli") {
      const bin = (account.auth as any).binary as string;
      const profile = (account.auth as any).loginProfile as string | undefined;
      const st = await cliAuthStatus(bin, profile);
      return { state: st.loggedIn ? "ok" : "expired", checkedAt: at, detail: st.detail };
    }
    const r = await testAccount(account);
    if (r.ok) return { state: "ok", checkedAt: at };
    return { state: classifyError(account.provider, { message: r.message }), checkedAt: at, detail: r.message };
  } catch (e) {
    return { state: classifyError(account.provider, e), checkedAt: at, detail: String((e as any)?.message ?? e) };
  }
}
```

Add the imports at the top of `health.ts`:

```ts
import { putAccount } from "./store.ts";
import { testAccount, cliAuthStatus } from "./onboard.ts";
```

> Note on cycles: `onboard.ts` imports `resolve.ts` and `store.ts`, not `health.ts`, so `health.ts → onboard.ts` is safe. If `bun test` reports a cycle, break it by having `checkHealth` take `testAccount`/`cliAuthStatus` as injected params from the caller instead of importing them.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/health-cache.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/accounts/health.ts src/accounts/types.ts
git commit -m "feat(accounts): health cache + checkHealth probe"
```

### Task 2.3: Health badges in the list + touchpoint sweeps

**Files:**
- Modify: `src/ui/types.ts` (`AccountRow` gains `health?: HealthState`)
- Modify: `src/ui/App.tsx` (`buildAccountView` reads `a.health`; boot sweep; refresh on `/account` already exists — extend to API-key accounts too)
- Modify: the `AccountView` renderer component (render a badge glyph per state)
- Modify: `src/ui/theme.ts` if a new glyph/color is needed (keep the restrained palette)
- Test: `test/account-badge.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/account-badge.test.ts
import { test, expect } from "bun:test";
import { badgeFor } from "../src/commands.ts";

test("badgeFor maps state → label", () => {
  expect(badgeFor("ok")).toMatch(/ready/);
  expect(badgeFor("expired")).toMatch(/expired/);
  expect(badgeFor("invalid")).toMatch(/invalid/);
  expect(badgeFor("rate-limited")).toMatch(/limited/);
  expect(badgeFor("no-credit")).toMatch(/credit/);
  expect(badgeFor("unknown")).toMatch(/—|unknown/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/account-badge.test.ts`
Expected: FAIL — `badgeFor` not exported.

- [ ] **Step 3: Implement `badgeFor` and surface it**

Add to `src/commands.ts`:

```ts
import type { HealthState } from "./accounts/types.ts";

export function badgeFor(s: HealthState | undefined): string {
  switch (s) {
    case "ok": return "✓ ready";
    case "expired": return "⚠ expired";
    case "invalid": return "✗ invalid";
    case "rate-limited": return "⏳ limited";
    case "no-credit": return "✗ no credit";
    default: return "— unknown";
  }
}
```

Use `badgeFor` in `formatAccounts` per row (replace the ad-hoc `status` string with `badgeFor(a.health?.state)` for non-active, non-CLI rows; keep "active" for the live subscription). In `buildAccountView`, set `health: a.health?.state` on each row and have the renderer print `badgeFor(row.health)`.

- [ ] **Step 4: Add the boot health sweep**

In `src/ui/App.tsx`, near the existing startup effect that restores the active account (around the `loadPrefs().activeAccount` effect, ~line 483), add a non-blocking parallel sweep that probes every account whose cached health isn't fresh and writes results back, then refreshes the status cache:

```ts
// Boot: probe accounts whose health is stale so the first /account is accurate.
useEffect(() => {
  let cancelled = false;
  void (async () => {
    const now = Date.now();
    const stale = listAccounts().filter((a) => !isFresh(a.health, now));
    await Promise.all(stale.map(async (a) => {
      const h = await checkHealth(a);
      if (cancelled) return;
      recordHealth(a, h.state, h.detail);
    }));
  })();
  return () => { cancelled = true; };
}, []); // once on mount
```

Add imports: `import { checkHealth, recordHealth, isFresh } from "../accounts/health.ts";`

- [ ] **Step 5: Refresh on `/account` for API-key accounts too**

In `showList`'s async body, alongside the existing `checkCliAccounts`, probe API-key accounts whose cache is stale via `checkHealth` and `recordHealth`, then build the view from the refreshed `listAccounts()`. Keep it best-effort (wrap in try/catch; never block the list render).

- [ ] **Step 6: Run the full suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(accounts): health badges + boot/list health sweeps"
```

---

## Phase 3 — Failover: pool ranking, structured failures, the loop

### Task 3.1: Model-family equivalence + candidate accounts (pure)

A pool for a model is every account that can serve that model — same provider, plus cross-provider equivalents (Claude via Anthropic / Bedrock / Vertex / subscription).

**Files:**
- Create: `src/model/family.ts` (`modelFamily`, `candidateModelsFor`)
- Test: `test/model-family.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/model-family.test.ts
import { test, expect } from "bun:test";
import { modelFamily } from "../src/model/family.ts";

test("collapses provider-specific ids to a shared family", () => {
  expect(modelFamily("claude-sonnet-4-6")).toBe("claude-sonnet-4");
  expect(modelFamily("bedrock/anthropic.claude-sonnet-4-20250514-v1:0")).toBe("claude-sonnet-4");
  expect(modelFamily("claude-opus-4-8")).toBe("claude-opus-4");
  expect(modelFamily("bedrock/anthropic.claude-opus-4-20250514-v1:0")).toBe("claude-opus-4");
});

test("gemini across direct + vertex", () => {
  expect(modelFamily("gemini-3.5-flash")).toBe("gemini-3.5-flash");
  expect(modelFamily("vertex/gemini-3.5-flash")).toBe("gemini-3.5-flash");
});

test("unknown ids fall back to themselves", () => {
  expect(modelFamily("deepseek-v4-pro")).toBe("deepseek-v4-pro");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/model-family.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `family.ts`**

```ts
// src/model/family.ts
// Cross-provider model equivalence. Two model ids share a FAMILY when they are
// the same underlying model offered through different providers (Anthropic API,
// Bedrock, Vertex, a subscription CLI). Failover ranks accounts whose servable
// models share the requested model's family. Keep this DATA-driven and small.
import { MODELS, type ModelSpec } from "../providers.ts";

// Ordered regex → family. First match wins. Strip any "provider/" prefix first.
const FAMILY_RULES: [RegExp, string][] = [
  [/claude.*opus-4/, "claude-opus-4"],
  [/claude.*sonnet-4/, "claude-sonnet-4"],
  [/claude.*haiku-4/, "claude-haiku-4"],
  [/gpt-5\.5-pro/, "gpt-5.5-pro"],
  [/gpt-5\.5-mini/, "gpt-5.5-mini"],
  [/gpt-5\.5/, "gpt-5.5"],
  [/gemini-3\.5-flash/, "gemini-3.5-flash"],
  [/gemini-3\.1-pro/, "gemini-3.1-pro"],
  [/gemini-3\.1-flash-lite/, "gemini-3.1-flash-lite"],
];

/** Normalize a model id (any provider) to a shared family key. */
export function modelFamily(id: string): string {
  const bare = id.replace(/^[a-z0-9-]+\//, "").toLowerCase(); // drop "bedrock/" etc
  for (const [re, fam] of FAMILY_RULES) if (re.test(bare)) return fam;
  return id;
}

/** Every registered ModelSpec whose family matches the given model. */
export function candidateModelsFor(model: ModelSpec): ModelSpec[] {
  const fam = modelFamily(model.id);
  return MODELS.filter((m) => modelFamily(m.id) === fam);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/model-family.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/model/family.ts test/model-family.test.ts
git commit -m "feat(model): cross-provider model family equivalence"
```

### Task 3.2: `rank` — the ordered account pool

**Files:**
- Modify: `src/accounts/resolve.ts` (`AccountResolver.rank(model) → {account, model}[]`; keep `pick`)
- Test: `test/account-rank.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/account-rank.test.ts
import { test, expect } from "bun:test";
import { rankCandidates, type Candidate } from "../src/accounts/resolve.ts";
import type { Account } from "../src/accounts/types.ts";
import { MODELS } from "../src/providers.ts";

const A = (over: Partial<Account>): Account => ({
  id: "x", slug: "x", label: "x", provider: "anthropic", exec: "in-loop",
  auth: { kind: "api-key", ref: "x:api-key" }, enabled: true, addedAt: 0, ...over,
});
const sonnet = MODELS.find((m) => m.id === "claude-sonnet-4-6")!;

test("healthy ranks before unknown before unhealthy", () => {
  const accts = [
    A({ id: "bad", slug: "bad", health: { state: "invalid", checkedAt: 1 } }),
    A({ id: "good", slug: "good", health: { state: "ok", checkedAt: 1 } }),
    A({ id: "meh", slug: "meh" }), // unknown
  ];
  const ranked = rankCandidates(sonnet, accts).map((c: Candidate) => c.account.id);
  expect(ranked).toEqual(["good", "meh", "bad"]);
});

test("includes cross-provider accounts and binds the right model id", () => {
  const accts = [
    A({ id: "anth", slug: "anth", provider: "anthropic", health: { state: "ok", checkedAt: 1 } }),
    A({ id: "bed", slug: "bed", provider: "bedrock", health: { state: "ok", checkedAt: 1 },
        auth: { kind: "aws", accessKeyIdRef: "a", secretKeyRef: "b", region: "us-east-1" } }),
  ];
  const ranked = rankCandidates(sonnet, accts);
  const bed = ranked.find((c) => c.account.id === "bed");
  expect(bed?.model.provider).toBe("bedrock"); // bound to the bedrock sonnet spec
});

test("excludes accounts whose provider serves no model in the family", () => {
  const accts = [A({ id: "ds", slug: "ds", provider: "deepseek", health: { state: "ok", checkedAt: 1 } })];
  expect(rankCandidates(sonnet, accts)).toHaveLength(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/account-rank.test.ts`
Expected: FAIL — `rankCandidates` not exported.

- [ ] **Step 3: Implement `rankCandidates` + `rank`**

In `src/accounts/resolve.ts` add:

```ts
import { candidateModelsFor } from "../model/family.ts";
import { listAccounts } from "./store.ts";
import type { HealthState } from "./types.ts";
import type { ModelSpec } from "../providers.ts";

export interface Candidate {
  account: Account;
  model: ModelSpec; // the provider-specific spec to run on this account
}

// Lower = better. Healthy first, unknown next, unhealthy last.
function healthRank(s: HealthState | undefined): number {
  if (s === "ok") return 0;
  if (s === undefined || s === "unknown" || s === "real-error") return 1;
  if (s === "rate-limited") return 2; // transient; better than a dead key
  return 3; // expired / invalid / no-credit
}

/** Pure: given a target model and a set of accounts, return failover candidates
 *  best-first. Each candidate binds the account to the provider-specific spec. */
export function rankCandidates(model: ModelSpec, accounts: Account[]): Candidate[] {
  const family = candidateModelsFor(model); // all specs in the family
  const byProvider = new Map<string, ModelSpec>();
  for (const m of family) if (!byProvider.has(m.provider)) byProvider.set(m.provider, m);
  // Prefer the exact requested spec for its own provider.
  byProvider.set(model.provider, model);

  const cands: Candidate[] = [];
  for (const a of accounts) {
    if (!a.enabled) continue;
    const spec = byProvider.get(a.provider);
    if (!spec) continue; // this account's provider can't serve the family
    cands.push({ account: a, model: spec });
  }
  // Stable sort by health; preserve input order within a tier (user order).
  return cands.map((c, i) => ({ c, i }))
    .sort((x, y) => healthRank(x.c.account.health?.state) - healthRank(y.c.account.health?.state) || x.i - y.i)
    .map(({ c }) => c);
}

/** Live ranking from the registry. */
export function rank(model: ModelSpec): Candidate[] {
  return rankCandidates(model, listAccounts());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/account-rank.test.ts && bun run typecheck`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/accounts/resolve.ts test/account-rank.test.ts
git commit -m "feat(accounts): rank — model-keyed cross-provider account pool"
```

### Task 3.3: Structured failure from `runTask`

So the failover loop can tell a credential failure from real output, without the raw error hitting the UI prematurely.

**Files:**
- Modify: `src/agent/run.ts` (track `producedOutput`; add `reportErrors` opt; return `failure`)
- Test: `test/run-failure.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/run-failure.test.ts
import { test, expect } from "bun:test";
import { runTask } from "../src/agent/run.ts";
import { MODELS } from "../src/providers.ts";

const model = MODELS.find((m) => m.id === "claude-haiku-4-5")!;

// An async iterable that yields an error part then ends, simulating the SDK.
async function* errStream() {
  yield { type: "error", error: { statusCode: 401, message: "invalid x-api-key" } };
}

test("with reportErrors:false, runTask returns a structured failure and emits no error event", async () => {
  const events: any[] = [];
  const res = await runTask({
    model, messages: [], onEvent: (e) => events.push(e),
    _stream: errStream(), reportErrors: false,
  });
  expect(res.failure).toBeTruthy();
  expect(res.failure!.producedOutput).toBe(false);
  expect(res.failure!.raw).toMatchObject({ statusCode: 401 });
  expect(events.find((e) => e.type === "error")).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/run-failure.test.ts`
Expected: FAIL — `failure` is undefined / error event still emitted.

- [ ] **Step 3: Implement structured failure**

In `src/agent/run.ts`:

- Add to the `opts` type: `reportErrors?: boolean;` (default `true`).
- Change the return type to `Promise<{ messages: ModelMessage[]; usage: Usage; failure?: { message: string; raw: unknown; producedOutput: boolean } }>`.
- Add `let producedOutput = false;` near `let errored = false;`. Set `producedOutput = true;` in the `text-delta` case (when `t` is non-empty) and in `tool-input-start` / `tool-call` (when a tool actually starts).
- Add `let failureRaw: unknown = undefined;`. In `emitErr`, capture the raw error and gate the event:

```ts
  const emitErr = (err: unknown) => {
    if (errored || signal?.aborted) return;
    errored = true;
    failureRaw = err;
    if (opts.reportErrors === false) return; // caller (failover) will decide
    onEvent({ type: "error", message: cleanError(err) });
  };
```

- Before `return { messages: next, usage }`, build the failure:

```ts
  const failure = errored ? { message: cleanError(failureRaw), raw: failureRaw, producedOutput } : undefined;
  // Don't emit the finished/done phase as "ok" if we suppressed an error for the caller.
  onEvent({ type: "phase", label: errored ? "blocked" : "finished", state: errored ? "err" : "ok" });
  onEvent({ type: "done", usage });
  return { messages: next, usage, failure };
```

(Remove the now-duplicated phase/done lines that previously sat at the end.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/run-failure.test.ts && bun test && bun run typecheck`
Expected: PASS, and existing run tests still green (default `reportErrors` true keeps old behavior).

- [ ] **Step 5: Commit**

```bash
git add src/agent/run.ts test/run-failure.test.ts
git commit -m "feat(agent): runTask returns structured failure (for failover)"
```

### Task 3.4: The failover loop

**Files:**
- Create: `src/agent/failover.ts`
- Test: `test/failover.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/failover.test.ts
import { test, expect } from "bun:test";
import { runWithFailover } from "../src/agent/failover.ts";
import type { Candidate } from "../src/accounts/resolve.ts";
import type { Account } from "../src/accounts/types.ts";
import { MODELS } from "../src/providers.ts";

const sonnet = MODELS.find((m) => m.id === "claude-sonnet-4-6")!;
const acct = (id: string): Account => ({
  id, slug: id, label: id, provider: "anthropic", exec: "in-loop",
  auth: { kind: "api-key", ref: `${id}:api-key` }, enabled: true, addedAt: 0,
});

test("advances to the next candidate on a credential failure before any output", async () => {
  const used: string[] = [];
  const candidates: Candidate[] = [
    { account: acct("bad"), model: sonnet },
    { account: acct("good"), model: sonnet },
  ];
  const res = await runWithFailover({
    candidates,
    onEvent: () => {},
    recordHealth: () => {},
    resolveCreds: async () => ({ apiKey: "k" }),
    runOne: async ({ account }) => {
      used.push(account.id);
      if (account.id === "bad") {
        return { messages: [], usage: { inputTokens: 0, outputTokens: 0 },
                 failure: { message: "invalid x-api-key", raw: { statusCode: 401, message: "invalid x-api-key" }, producedOutput: false } };
      }
      return { messages: [], usage: { inputTokens: 1, outputTokens: 1 } };
    },
  });
  expect(used).toEqual(["bad", "good"]);
  expect(res.usedAccountId).toBe("good");
});

test("does NOT advance on a real (non-credential) error", async () => {
  const used: string[] = [];
  const candidates: Candidate[] = [{ account: acct("a"), model: sonnet }, { account: acct("b"), model: sonnet }];
  await runWithFailover({
    candidates, onEvent: () => {}, recordHealth: () => {}, resolveCreds: async () => ({ apiKey: "k" }),
    runOne: async ({ account }) => {
      used.push(account.id);
      return { messages: [], usage: { inputTokens: 0, outputTokens: 0 },
               failure: { message: "fetch failed", raw: { message: "fetch failed" }, producedOutput: false } };
    },
  });
  expect(used).toEqual(["a"]); // stopped, no failover on real-error
});

test("does NOT advance once output was produced (no mid-stream switch)", async () => {
  const used: string[] = [];
  const candidates: Candidate[] = [{ account: acct("a"), model: sonnet }, { account: acct("b"), model: sonnet }];
  await runWithFailover({
    candidates, onEvent: () => {}, recordHealth: () => {}, resolveCreds: async () => ({ apiKey: "k" }),
    runOne: async ({ account }) => {
      used.push(account.id);
      return { messages: [], usage: { inputTokens: 0, outputTokens: 0 },
               failure: { message: "rate limit", raw: { statusCode: 429 }, producedOutput: true } };
    },
  });
  expect(used).toEqual(["a"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/failover.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `failover.ts`**

```ts
// src/agent/failover.ts
// Wraps a single model turn in an ordered account pool. On a credential-class
// failure that happened BEFORE any output, advance to the next candidate; on a
// real error (or once output streamed), stop. Records health for each attempt
// and surfaces a clear, actionable error if the whole pool is exhausted.
import { classifyError, isCredentialFailure, type HealthState } from "../accounts/health.ts";
import type { Candidate } from "../accounts/resolve.ts";
import type { Account, ResolvedCreds } from "../accounts/types.ts";
import type { OnEvent, Usage } from "./events.ts";
import type { ModelMessage } from "ai";

export interface RunOneResult {
  messages: ModelMessage[];
  usage: Usage;
  failure?: { message: string; raw: unknown; producedOutput: boolean };
}

export interface FailoverOpts {
  candidates: Candidate[];
  onEvent: OnEvent;
  recordHealth: (account: Account, state: HealthState, detail?: string) => void;
  resolveCreds: (account: Account) => Promise<ResolvedCreds>;
  runOne: (args: { account: Account; model: Candidate["model"]; creds: ResolvedCreds }) => Promise<RunOneResult>;
}

export interface FailoverResult extends RunOneResult {
  usedAccountId?: string;
}

// A friendly one-line fix per failure state — shown when the pool is exhausted.
export function fixHint(account: Account, state: HealthState): string {
  if (account.exec === "cli") return `re-login: /account login ${account.slug ?? account.id}`;
  if (state === "no-credit") return `add credit, or switch: /account <name>`;
  if (state === "invalid" || state === "expired") return `replace the key: /account add ${account.provider} <key>`;
  if (state === "rate-limited") return `wait, or switch: /account <name>`;
  return `check: /account ${account.slug ?? account.id}`;
}

export async function runWithFailover(opts: FailoverOpts): Promise<FailoverResult> {
  const { candidates, onEvent, recordHealth, resolveCreds, runOne } = opts;
  const tried: { account: Account; state: HealthState; message: string }[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const { account, model } = candidates[i]!;
    const creds = await resolveCreds(account);
    const res = await runOne({ account, model, creds });

    if (!res.failure) {
      recordHealth(account, "ok");
      return { ...res, usedAccountId: account.id };
    }

    const state = classifyError(account.provider, res.failure.raw);
    recordHealth(account, state, res.failure.message);
    tried.push({ account, state, message: res.failure.message });

    const canFailover = isCredentialFailure(state) && !res.failure.producedOutput && i < candidates.length - 1;
    if (canFailover) {
      const next = candidates[i + 1]!.account;
      onEvent({ type: "phase", label: `${account.slug ?? account.id} ${state}`, detail: `→ using ${next.slug ?? next.id}`, state: "err" });
      continue;
    }

    // Terminal: emit one consolidated, actionable error now.
    onEvent({ type: "error", message: failureReport(tried) });
    return { ...res, usedAccountId: account.id };
  }

  onEvent({ type: "error", message: failureReport(tried) });
  return { messages: candidates[0]?.model ? [] : [], usage: { inputTokens: 0, outputTokens: 0 } };
}

function failureReport(tried: { account: Account; state: HealthState; message: string }[]): string {
  if (tried.length === 1) {
    const t = tried[0]!;
    return `${t.account.slug ?? t.account.id} failed (${t.state}): ${t.message}\n  ${fixHint(t.account, t.state)}`;
  }
  const lines = tried.map((t) => `  • ${t.account.slug ?? t.account.id} — ${t.state}: ${t.message}\n      ${fixHint(t.account, t.state)}`);
  return [`all ${tried.length} accounts for this model failed:`, ...lines].join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/failover.test.ts && bun run typecheck`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/failover.ts test/failover.test.ts
git commit -m "feat(agent): runWithFailover — ordered pool with clear exhaustion errors"
```

### Task 3.5: Wire failover into the App's runner

**Files:**
- Modify: `src/ui/App.tsx` (`defaultRunner`: build candidates from `rank(model)`, call `runWithFailover` with `runOne` delegating to `runTask({ reportErrors:false })`; record the used account; surface re-login)

- [ ] **Step 1: Locate the current in-loop call**

In `src/ui/App.tsx` `defaultRunner`, after the `if (cli) { … }` subscription branch, find where it currently resolves a single account + creds and calls `runTask`. (Grep for `runTask(` in `App.tsx`.)

- [ ] **Step 2: Replace the single-account call with failover**

Build candidates for the selected model and run the pool. Replace the single `runTask` call with:

```ts
import { rank } from "../accounts/resolve.ts";
import { runWithFailover } from "../agent/failover.ts";
import { checkHealth, recordHealth } from "../accounts/health.ts";
// ...
const candidates = rank(choice.model);
// If no stored accounts match (env-only setup), fall back to a single env-cred run.
if (!candidates.length) {
  const r = await runTask({ model: choice.model, messages, onEvent, signal, plan, system, creds, effort });
  return { messages: r.messages, usage: r.usage };
}
const r = await runWithFailover({
  candidates,
  onEvent,
  recordHealth,
  resolveCreds,
  runOne: async ({ account, model, creds }) => {
    usedAccountRef.current = account.id;
    return runTask({ model, messages, onEvent, signal, plan, system, creds, effort, reportErrors: false });
  },
});
if (r.usedAccountId) markUsed(r.usedAccountId);
return { messages: r.messages, usage: r.usage };
```

(Names like `choice`, `messages`, `system`, `effort`, `plan`, `signal`, `resolveCreds` already exist in this scope — match the existing variable names exactly; adjust if the local names differ.)

- [ ] **Step 3: Typecheck + full suite**

Run: `bun run typecheck && bun test`
Expected: all pass.

- [ ] **Step 4: Manual smoke (documented, not automated)**

With two Anthropic accounts where one key is deliberately wrong, send a prompt and confirm: the bad one is marked, the turn completes on the good one, and a phase line shows `bad-key invalid → using good-key`.

- [ ] **Step 5: Commit**

```bash
git add src/ui/App.tsx
git commit -m "feat(app): route in-loop turns through the failover pool"
```

### Task 3.6: One-step re-login for expired subscriptions

**Files:**
- Modify: `src/commands.ts` (register `/account login <slug>` help text)
- Modify: `src/ui/App.tsx` (`case "account"`: handle `login` subcommand → run the vendor login flow for that account's profile, reusing `cliLoginArgs`/`signInCli`)
- Modify: `src/agent/cli-backend.ts` (when a CLI turn fails with an expired/not-logged-in classification, emit an error whose message names the exact `/account login <slug>` command)

- [ ] **Step 1: Add the `login` subcommand to the `/account` parser**

In `src/ui/App.tsx` `case "account"`, before the final fallthrough, handle:

```ts
if (subL === "login") {
  const ref = findAccountRef(parts.slice(1).join(" "), all);
  const a = ref.account ?? (activeCliRef.current ? getAccount(activeCliRef.current.id) : undefined);
  if (!a || a.exec !== "cli") { notice("usage: /account login <claude-or-codex-account-name>"); return; }
  const m = accountName(a).match(/\((.*)\)/)?.[1];
  signInCli(`${a.provider.replace(/-cli$/, "")}${m ? ` ${m}` : ""}`.trim());
  return;
}
```

(`signInCli` already drives the vendor interactive login for a named account — confirm its signature and reuse it; it is referenced at line ~2171.)

- [ ] **Step 2: Make CLI failures name the re-login command**

In `src/agent/cli-backend.ts`, where a turn error is surfaced (grep the existing `reloginCommand` usage in `App.tsx` around line 1096 — the CLI runner already builds a relogin hint), ensure the message classifies via `classifyError(provider, err)` and, when `expired`, leads with: `subscription signed out — re-login: /account login <slug>`. Use the account's `slug`.

- [ ] **Step 3: Add help text**

In `src/commands.ts` `HIDDEN` or the command list, document `/account login <name>` under the accounts group description for `/account` (extend its `desc` to mention `login` re-auth). No new top-level command entry is required since it's a subcommand.

- [ ] **Step 4: Typecheck + full suite**

Run: `bun run typecheck && bun test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(accounts): one-step /account login re-auth for expired subscriptions"
```

---

## Phase 4 — Universal ingestion ("throw anything at it")

### Task 4.1: `sniffCredential` (pure)

**Files:**
- Create: `src/accounts/sniff.ts`
- Test: `test/sniff.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/sniff.test.ts
import { test, expect } from "bun:test";
import { sniffCredential } from "../src/accounts/sniff.ts";

test("detects API keys by prefix", () => {
  expect(sniffCredential("sk-ant-abc123")).toMatchObject({ kind: "api-key", provider: "anthropic" });
  expect(sniffCredential("sk-proj-abc")).toMatchObject({ kind: "api-key", provider: "openai" });
  expect(sniffCredential("AIzaSyABC")).toMatchObject({ kind: "api-key", provider: "google" });
  expect(sniffCredential("sk-or-v1-abc")).toMatchObject({ kind: "openai-compat", provider: "openrouter" });
});

test("detects an AWS access key id", () => {
  const g = sniffCredential("AKIAIOSFODNN7EXAMPLE");
  expect(g.kind).toBe("aws");
  expect(g.provider).toBe("bedrock");
  expect(g.missing).toContain("secretAccessKey");
});

test("detects a pasted AWS credentials block", () => {
  const g = sniffCredential("aws_access_key_id=AKIAIOSFODNN7EXAMPLE\naws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
  expect(g.kind).toBe("aws");
  expect(g.fields.accessKeyId).toBe("AKIAIOSFODNN7EXAMPLE");
  expect(g.fields.secretAccessKey).toContain("wJalrXUtnFEMI");
  expect(g.missing).not.toContain("secretAccessKey");
});

test("detects a Vertex service-account JSON", () => {
  const json = JSON.stringify({ type: "service_account", project_id: "my-proj", private_key: "x" });
  const g = sniffCredential(json);
  expect(g.kind).toBe("vertex");
  expect(g.fields.project).toBe("my-proj");
});

test("detects an Azure endpoint", () => {
  const g = sniffCredential("https://my-resource.openai.azure.com");
  expect(g.kind).toBe("azure");
  expect(g.fields.resourceName).toBe("my-resource");
  expect(g.missing).toContain("apiKey");
});

test("detects a Vercel AI Gateway key", () => {
  const g = sniffCredential("vck_abcdEFGHijkl");
  expect(g.kind).toBe("openai-compat");
  expect(g.provider).toBe("vercel-gateway");
});

test("unknown bearer → unknown, low confidence", () => {
  const g = sniffCredential("zzz-some-random-token-1234567890");
  expect(g.kind).toBe("unknown");
  expect(g.confidence).toBe("low");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/sniff.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `sniff.ts`**

```ts
// src/accounts/sniff.ts
// Identify a pasted credential — API key, AWS access key or credentials block,
// service-account JSON, Azure endpoint, gateway key — so /account add can route
// it and ask only for what's missing. Pure + tested. Detection only; no I/O.
import { detectProviderByKey, catalogProvider } from "./catalog.ts";
import type { AuthKind } from "./types.ts";

export interface CredentialGuess {
  kind: AuthKind | "unknown";
  provider?: string;
  fields: Record<string, string>;
  missing: string[];
  confidence: "high" | "low";
}

const AWS_KEY_RE = /\b((?:AKIA|ASIA)[A-Z0-9]{16})\b/;

export function sniffCredential(text: string): CredentialGuess {
  const t = text.trim();

  // 1) Service-account JSON (Vertex).
  if (/^\s*\{/.test(t) && /"type"\s*:\s*"service_account"/.test(t)) {
    try {
      const j = JSON.parse(t);
      return { kind: "vertex", provider: "vertex", fields: { project: j.project_id ?? "", serviceAccountJson: t }, missing: j.project_id ? ["location"] : ["project", "location"], confidence: "high" };
    } catch {
      return { kind: "vertex", provider: "vertex", fields: { serviceAccountJson: t }, missing: ["project", "location"], confidence: "low" };
    }
  }

  // 2) Azure / Foundry endpoint URL.
  const azure = t.match(/https?:\/\/([a-z0-9-]+)\.(?:openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com)/i);
  if (azure) {
    return { kind: "azure", provider: "azure", fields: { resourceName: azure[1]!, endpoint: t }, missing: ["apiKey"], confidence: "high" };
  }

  // 3) AWS credentials block (key=value lines).
  if (/aws_access_key_id\s*=/.test(t) || (AWS_KEY_RE.test(t) && /aws_secret_access_key|secret/i.test(t))) {
    const id = t.match(AWS_KEY_RE)?.[1] ?? "";
    const secret = t.match(/aws_secret_access_key\s*=\s*([A-Za-z0-9/+=]+)/i)?.[1] ?? "";
    const region = t.match(/(?:aws_)?region\s*=\s*([a-z0-9-]+)/i)?.[1] ?? "";
    const missing: string[] = [];
    if (!secret) missing.push("secretAccessKey");
    if (!region) missing.push("region");
    return { kind: "aws", provider: "bedrock", fields: { accessKeyId: id, secretAccessKey: secret, region }, missing, confidence: "high" };
  }

  // 4) Bare AWS access key id.
  const awsId = t.match(/^((?:AKIA|ASIA)[A-Z0-9]{16})$/)?.[1];
  if (awsId) {
    return { kind: "aws", provider: "bedrock", fields: { accessKeyId: awsId }, missing: ["secretAccessKey", "region"], confidence: "high" };
  }

  // 5) Vercel AI Gateway key.
  if (/^vck_/.test(t)) {
    return { kind: "openai-compat", provider: "vercel-gateway", fields: { apiKey: t }, missing: [], confidence: "high" };
  }

  // 6) Known API-key prefixes (anthropic, openai, google, openrouter, groq, …).
  const provider = detectProviderByKey(t);
  if (provider) {
    const cat = catalogProvider(provider);
    const kind: AuthKind = cat?.authKind === "openai-compat" ? "openai-compat" : "api-key";
    return { kind, provider, fields: { apiKey: t }, missing: [], confidence: "high" };
  }

  // 7) Bedrock long-lived API key (bearer, no recognizable prefix but base64-ish & long).
  //    Only when the user is clearly pasting a bearer (handled by guided fallback otherwise).

  // 8) Unknown.
  return { kind: "unknown", fields: { apiKey: t }, missing: ["provider"], confidence: "low" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/sniff.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/accounts/sniff.ts test/sniff.test.ts
git commit -m "feat(accounts): sniffCredential — identify any pasted credential"
```

### Task 4.2: Route `/account add <paste>` through the sniffer

**Files:**
- Modify: `src/ui/App.tsx` (`case "account"` → `add` branch: when the arg is a single pasted blob with no explicit provider, call `sniffCredential` and dispatch to the right `add*` function; when fields are missing, print a precise guided prompt)
- Modify: `src/accounts/onboard.ts` (`addByPastedKey` delegates to `sniffCredential` for non-prefix credentials)

- [ ] **Step 1: Make `addByPastedKey` use the sniffer**

In `src/accounts/onboard.ts`, replace `addByPastedKey` so it handles more than key prefixes:

```ts
import { sniffCredential } from "./sniff.ts";

export async function addByPastedKey(key: string): Promise<AddResult> {
  const g = sniffCredential(key);
  if (g.kind === "api-key" && g.provider) return addApiKeyAccount(g.provider, g.fields.apiKey ?? key);
  if (g.kind === "openai-compat" && g.provider) {
    const cat = catalogProvider(g.provider);
    if (cat?.baseUrl) return addApiKeyAccount(g.provider, g.fields.apiKey ?? key);
  }
  if (g.kind === "aws" && !g.missing.length) {
    return addBedrockAccount(g.fields.accessKeyId!, g.fields.secretAccessKey!, g.fields.region!);
  }
  return { ok: false, message: guidedMessageFor(g) };
}

// One-line instruction telling the user exactly what else to provide.
function guidedMessageFor(g: import("./sniff.ts").CredentialGuess): string {
  if (g.kind === "aws") return `looks like AWS/Bedrock — provide: /account add bedrock <access-key-id> <secret> <region>`;
  if (g.kind === "azure") return `looks like Azure (${g.fields.resourceName}) — provide the key: /account add azure ${g.fields.endpoint} <api-key>`;
  if (g.kind === "vertex") return `looks like a Vertex service account — provide: /account add vertex <project> <location> (then paste the JSON path)`;
  return `couldn't identify that credential — use /account add <provider> <key>, or /onboard providers to see options`;
}
```

> `addBedrockAccount` may not exist yet. If `onboard.ts` lacks a Bedrock add, add a minimal one mirroring `addAzureAccount` that stores `accessKeyIdRef`/`secretKeyRef` secrets and writes an `auth.kind === "aws"` account with `region`. Add a focused test in `test/sniff.test.ts` or a new `test/onboard-bedrock.test.ts` asserting the account shape (no live AWS call).

- [ ] **Step 2: Surface guided prompts in the App add branch**

In `src/ui/App.tsx` `add` branch, the existing `else if (detectProviderByKey(key)) res = await addByPastedKey(key);` becomes the catch-all `else res = await addByPastedKey(key);` so any unrecognized single token still goes through the sniffer and returns a precise guided message (instead of the current generic "isn't a recognized key").

- [ ] **Step 3: Typecheck + full suite**

Run: `bun run typecheck && bun test`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(accounts): /account add routes any paste through the sniffer"
```

### Task 4.3: Real connectivity checks for Bedrock / Vertex / Azure in `testAccount`

The current `testAccount` only checks field presence for cloud providers. Add a real, cheap probe where feasible.

**Files:**
- Modify: `src/accounts/onboard.ts` (`testAccount`: Bedrock `ListFoundationModels` via a SigV4-signed GET; Azure already lists models — keep; Vertex token check via metadata when ADC is present, else keep field check with a clear note)
- Test: `test/test-account.test.ts` (only the pure URL/region validation paths; do not hit the network)

- [ ] **Step 1: Write the failing test (pure validation only)**

```ts
// test/test-account.test.ts
import { test, expect } from "bun:test";
import { bedrockListUrl } from "../src/accounts/onboard.ts";

test("bedrockListUrl builds the regional endpoint", () => {
  expect(bedrockListUrl("us-east-1")).toBe("https://bedrock.us-east-1.amazonaws.com/foundation-models");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/test-account.test.ts`
Expected: FAIL — `bedrockListUrl` not exported.

- [ ] **Step 3: Implement `bedrockListUrl` and use SigV4 if available**

Add to `src/accounts/onboard.ts`:

```ts
export function bedrockListUrl(region: string): string {
  return `https://bedrock.${region}.amazonaws.com/foundation-models`;
}
```

In `testAccount`'s Bedrock branch, keep the existing key-shape validation, and additionally — if the AWS SDK signer is available in the project — perform a signed GET to `bedrockListUrl(region)` and return `ok` on 200. If signing isn't wired, keep the current "fields present (verified on first use)" message. (Do not add a heavy dependency just for this; field validation + first-use verification is acceptable for v1. Document the decision in a comment.)

- [ ] **Step 4: Run test + suite**

Run: `bun test test/test-account.test.ts && bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(accounts): real-ish testAccount coverage for Bedrock"
```

---

## Final integration

### Task 5.1: Docs + full verification

**Files:**
- Modify: `CLAUDE.md` (accounts section: note failover, names-only, health badges, `/account login`, paste-anything add)
- Modify: `src/commands.ts` `/account` desc (mention failover + login)

- [ ] **Step 1: Update CLAUDE.md accounts paragraph**

Add to the accounts bullets in `CLAUDE.md`: model-keyed cross-provider auto-failover (records health, surfaces which account ran), names-only switching with health badges, `/account login <name>` one-step re-auth, and `/account add <paste>` universal ingestion via `sniffCredential`.

- [ ] **Step 2: Full verification**

Run: `bun test && bun run typecheck`
Expected: all green. Record the counts.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs: accounts reliability (failover, health, names-only, ingestion)"
```

---

## Self-review (completed by plan author)

**Spec coverage:**
- Failover (model-keyed, cross-provider, auto + report) → Tasks 3.1–3.5 ✓
- Health (classify, cache, event-driven sweeps, no polling) → Tasks 2.1–2.3 ✓
- Names only, no numbers → Tasks 1.1–1.2 ✓
- Universal ingestion → Tasks 4.1–4.2; real testAccount → 4.3 ✓
- Clear failures + easy re-login → Tasks 3.4 (`failureReport`/`fixHint`), 3.6 (`/account login`) ✓
- Caveat: no mid-stream failover once output produced → enforced in Task 3.4 (`producedOutput` gate) ✓

**Type consistency:** `HealthState`/`AccountHealth` defined once in `types.ts`, re-exported from `health.ts`; `Candidate` defined in `resolve.ts` and consumed by `failover.ts`; `runTask` failure shape matches `RunOneResult.failure`. ✓

**Known v1 limitation (documented, not a gap):** cross-provider failover requires a registered ModelSpec per provider in the family (Task 3.1 data); a provider with no spec in `providers.ts` for that family won't be a candidate. That's correct behavior, not a bug.
