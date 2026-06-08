# Gearbox UI redesign — implementation report

Branch: `redesign/ui`. This is the running log required by the brief. It is updated
after every step. The cardinal rule governs everything here: **nothing is rendered
that is not backed by real state.** The final section ("Data provenance") must end
with an empty list of fabricated values.

## Baseline (before any change)

- Branch `redesign/ui` cut from `main` @ `7418df7`.
- `bun run typecheck` → clean (exit 0).
- `bun test` → **696 pass / 0 fail**, 85 files, ~9.8s.
- Pre-existing untracked tests (`test/preferences.test.ts`, `test/profiles.test.ts`,
  `test/tokens.test.ts`) were committed as-is in a baseline commit so the redesign
  diff stays isolated and the tree ends clean. They are not my work; they passed
  already.

## Theme facts (src/ui/theme.ts)

- One accent: `color.accent` `#56D4E0`, `color.accentDim` `#4F8C99`.
- Grey ramp: `text` `#E4E6EB` → `dim` `#8A909C` → `faint` `#5B626E`.
- Red (failure/destructive/error): `color.err` `#E5675C`.
- Green (ready/ok): `color.ok` `#6FCF97`.
- **No semantic amber/warn token.** Decision: add a minimal `warn` token reusing the
  existing in-palette amber hue (`#E0B057`, currently `codeNumber`). Used ONLY for the
  three "surprising routing" cases, low balance, and a key needing attention.
- Glyphs already present: `on ●` / `off ○` (status dots), `branch ⎇`, `rule ─`.

---

## Phase 0 — codebase map

Done via a 5-way parallel read-only discovery pass. Key facts:

**TUI layer.** Ink (React for terminals). Two render modes in `App.tsx` (~4100 lines, the
controller): **inline** (default — `<Static>` commits finished items to native scrollback,
only the live tail re-renders) and **fullscreen** (alt-screen, virtualized `Viewport`, with
`Panel` modal overlays for `/help` `/account` `/model` `/usage`). Fullscreen layout:
`Banner` (header, 3 rows) → `Viewport`/transcript → footer (`StatusBar` + palette + `Composer`).
Redraw is React/Ink reconciliation; `lines.ts` flattens items to styled `Line`s; `LineRow`
memoizes by line reference.

**Theme.** `src/ui/theme.ts` is the single source — `color` object + `glyph` set. One accent
(`accent #56D4E0`), three greys (`text`→`dim`→`faint`), `err #E5675C` (failure only),
`ok #6FCF97`, `run #7E8AF0`. **No semantic amber/warn token** — `run` (blue) is reused for
"near limit". I add one minimal `warn` token (the design needs amber for surprising routing /
low balance / key attention).

**The model-name bug.** `Banner.tsx:10` accepts a `model` prop but **never renders it** (header
shows only the "gearbox" wordmark); `StatusBar.tsx:121` renders `modelLabel` in the footer.
Same value sent to both; header silently drops it. Fix = one canonical per-turn routing line
(`routed → provider · model · $cost`) plus a policy (not model) label in the input box, so a
model name never appears in two places with two meanings.

**Real per-turn data (provenance for "no fake data"):**
- chosen model id — REAL (`routedRef.current.model`, `TurnMeta.model`, `model-pick` event).
- provider — REAL (`model-pick` event carries `{model, provider, reason}`, App.tsx ~1602).
- routing reason string — REAL (`ModelChoice.reason`, App.tsx ~1602).
- backend in-loop vs subscription/CLI — REAL (`ModelChoice.backend.kind`, `usedAccountRef`).
- per-turn tokens + cost — REAL (`Usage` captured in `run.ts`; cost via `estimateCost()` in
  `providers.ts`, applied in App.tsx ~2130; subscription seats are $0 marginal).
- **eligible candidate set** (for savings baseline) — computed live in `router.explain()` →
  `Scorecard.entries[]` (each has `estCostPerMtok`, `quality`, `verdict`, `chosen`), surfaced by
  `/why`, but **not persisted**. Needs a read-only capture hook to compute savings. GATED.
- **per-turn cost cap** — DOES NOT EXIST. `budget-guard.ts` has session/daily/monthly/total
  hard caps (pre-flight block), not a per-turn cap, and caps are not in the scoring formula.
  So the policy line must not claim "cap $X/turn", and the "surprising = cap hit" case maps only
  to a real budget-guard block, never a routing escalation.
- escalated-above-cheapest / provider-fallback signals — derivable: escalation from the
  scorecard (chosen vs cheapest eligible); fallback from the failover path (`failover.ts`,
  App.tsx ~1740 `shortFailure`/which-account-ran).

**Providers/accounts data.** `listAccounts()` (accounts.json) enumerates accounts; each carries
cached `health` (`ok/expired/invalid/no-credit/rate-limited/unknown/real-error`). **Balance is
exposed by exactly three providers** (`balance.ts`: openrouter, vercel-gateway, deepseek); all
others → `balance n/a` with session-spend fallback. Spend ledger in `usage.json`
(`AccountUsage.spentUSD` cumulative + day/month). Fix commands from `failover.ts fixHint()`:
CLI → `/account login <slug>`, API key → `/account add <provider> <key>`.

**Errors / LSP / tabs.** Errors render in ONE visual lane (`Transcript.tsx:616`, glyph `▲` +
red text); the "second location" is only the event emission, not a second render — so the
"dedupe" is mostly making it a clean red **left bar**. **LSP: zero runtime anywhere** — the only
mention is an aspirational doc string in `help/docs-bundle.ts`; there is no `LSP: ready` UI to
remove (borrowed furniture exists only in docs). **No tab strip exists** — UI is a single
scrolling view; the Session/Routing/Providers/Cost strip is net-new (fullscreen affordance,
will reuse the Panel data views).

**Tests.** `bun test`, 85 files in `test/`. Two patterns: pure-function (`import {test,expect}
from "bun:test"`) and Ink component (`render()` from `ink-testing-library`, assert on
`.lastFrame()`). Pure helpers are exported and unit-tested directly (e.g. `formatDuration` from
App.tsx, `statusBarLayout` from StatusBar.tsx).

**Incident logged:** during discovery a read-only agent ran `git checkout main` in the shared
working dir, moving HEAD off `redesign/ui`. Caught and restored; baseline commit was safe. All
later work is sequential in the main loop to avoid shared-cwd git churn.

## Step log

(appended after each implementation step)

## Data provenance — anything on screen NOT backed by real data

This list MUST be empty at the end.

(tracked as we go)

## TODOs left and why

(tracked as we go)
