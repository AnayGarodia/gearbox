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

### Step 1a — `warn` theme token (commit 31f9b8a)
Added the one semantic amber token (`color.warn` `#E0B057`), distinct from `err` (red). Spent only
on a surprising routing decision / low balance / key attention.

### Step 1b — pure `routing-line.ts` module (commit 31f9b8a)
`formatTurnCost`, `classifySurprise`, `buildRoutingLine`, `routingLineText`. Subscription seats →
"subscription seat" (honest ~$0 marginal); sub-cent metered → "<$0.01"; NaN/neg guarded. Surprise
precedence cap > fallback > escalation. 8 unit tests.

### Step 1c — wire the post-turn routing line (commit 579e33e)
The single canonical per-turn line `routed → provider · model · $cost`, printed after each turn.
Replaced the pre-turn "using …" item (which had no cost) with a post-turn item carrying the **real**
recorded cost. Model/provider come from the spec that actually ran (`routedRef` follows failover);
`$0` renders as "subscription seat". Amber + reason only on a real surprising signal — provider
**fallback** is wired now (`fellOverFromRef`, set in the failover loop). Escalation and cap-hit are
structurally supported by the classifier but **gated** (their signals aren't captured yet — see
Step 4 / TODOs). 704 pass / 0 fail.

### Step 1d/1e — input box + footer split (commit 9dbd2aa)
**Input box**: the Composer is now a box with a single accent left bar (Ink 5 per-side border,
pink in bash mode) and a policy/branch line inside: `auto-route · ⎇ main` (or `plan · auto-route`,
`pinned <model>`, or the subscription label). Shows the **policy**, never a bare model name in the
auto case. New pure `policyLabel()` (`src/ui/policy.ts`) + 6 tests; the line is omitted during
onboarding (keeps the first-run splash uncluttered and avoids a height overflow).
**Footer split**: keys left (a quiet legend + rare attention chips: offline / yolo / low-context),
model + session cost right. Branch moved to the input box; routing pick moved to the per-turn line;
effort/tokens dropped from the footer. **Context shows only when low** (≤15% remaining ⇒ ctxPct≥85),
amber. `statusBarLayout`/`statusBarHit` rewritten for the right-aligned model click zone (effort
click dropped — still set via `/effort` + shift+tab); chrome constants reconciled (`-2`→`-3`, footer
`3`→`4`). 713 pass / 0 fail. App launches clean.

Used a parallel architect fan-out (6 read-only agents) to produce apply-ready blueprints for the
remaining surfaces before implementing each.

### Step 2 — live status verb + low-context notice (commit 52cbc8d)
The live status verb now names the running tool (`toolVerbFromName`: Reading/Editing/Running/…) on
tool-start, restoring the turn's workshop phrase between tools. A `lowContextNotice` amber row
(`<N>% context left · /compact`) shows under the working strip only when genuinely low (≥85% used),
never during the linger beat. The one-line tool-call collapse, real line counts, diff deltas
(`+N -M`), and "esc to interrupt" already existed and were left as-is. Pure helpers in `character.ts`,
unit + render tested.

### Step 3 — providers cold-open (commit 7116740)
`providers-view.ts` (pure) + `ProvidersView` component. One row per account: a health dot (green
ready / amber attention / red broken / faint unknown), label, and an **honest money field** — a real
remaining balance ONLY for the three providers whose API exposes it (`balanceExposed`: openrouter,
vercel-gateway, deepseek) and only when fresh; everyone else shows session spend or an explicit
`balance n/a`. **A balance is never fabricated.** Broken accounts carry the exact `fixHint()` command.
Shown in the welcome hero when accounts exist. 9 + 3 tests.

### Step 5 — error lane + LSP + palette (commit e136692)
Error lane redesigned to one red left bar (`▎`) down the whole message, shown once, in both
renderers; confirmed no second floating/boxed error to remove. **LSP**: there is no LSP UI anywhere
to remove (the only mention is an aspirational roadmap line in `DESIGN.md`, framed as future work —
not a false UI claim); the brief's "remove borrowed LSP furniture" is satisfied by absence, and the
roadmap doc was left untouched (out-of-scope file). Palette now colours the command primary and the
description secondary, with the one accent-highlighted selected row; lists only real commands.

### Step 4 — tab strip + Cost tab + savings + policy (commit 119ae60)
A fullscreen tab strip (Session · Routing · Providers · Cost), active tab in accent, under the
Banner; switch by clicking (tested `tabStripHit`), `⌃T` to cycle, or submitting a prompt. `cost-tab.ts`
(pure): the savings estimate and the honest policy string.
- **Savings is always real, with no routing-hot-path hook.** Baseline = each turn's tokens × the
  priciest registry model's price; the most-expensive *eligible* model is the premium one for any
  turn (it clears every quality bar — eligibility only excludes models for lacking capability). Minus
  actual cost, clamped ≥ 0, labelled `~ … vs always-premium`. Subscription seats (actual $0) count
  their full premium cost as saved. This is simpler and lower-risk than the blueprint's `TurnMeta` +
  `explain()` capture, and equally honest.
- **Policy line states only what the engine honours**: `cheapest model passing the quality bar` +
  real global `prefer` + real budget-guard caps (session/daily/monthly/total). It NEVER prints a
  per-turn cap, because the engine has none.
Cost/Routing tabs show only real data (spend, per-account spend, last routed pick, remembered
preferences); Providers tab reuses Step 3's view. 8 + 4 tests.

---

## Data provenance — anything on screen NOT backed by real data

**This list is empty.** Every value rendered by the redesign is traced to real state below; where a
value is not available, the UI shows an explicit `n/a`, omits the field, or labels an estimate.

| Surface element | Source (real) |
| --- | --- |
| per-turn `routed → provider · model · $cost` | `routedRef.model` (follows failover), the recorded turn `cost` (`$0` ⇒ "subscription seat"), App.tsx:2141 |
| per-turn line amber + reason | only the real `fellOverFromRef` (provider fallback) fires; escalation/cap are gated off until a real signal exists |
| input-box policy (`auto-route` / `pinned X` / sub) | `selector instanceof RoutingSelector/FixedSelector` + `activeCli` + `mode` (`policyLabel`) |
| input-box branch | `gitBranch()` (App.tsx) |
| footer model + session cost | `modelLabel`; `estimateCost(session.turns)` (omitted < $0.005) |
| footer chips (offline / yolo / low-ctx) | `online`, `yolo`, `ctxPct≥85` — all real state |
| live verb | `toolVerbFromName(e.name)` from the real tool-start event |
| low-context notice | real `ctxPct` (from token counts vs window); shown only ≥85% used |
| provider health dot | `Account.health.state` |
| provider balance | real `AccountUsage.balance.remainingUSD` for the 3 balance-exposing providers (fresh only); else real spend or explicit `balance n/a` |
| provider fix command | `fixHint(account, state)` |
| Cost spend / per-account spend | `estimateCost` / `loadUsage().spentUSD` |
| Cost savings (`~ … vs always-premium`) | computed from real turn tokens × real registry prices − real actual cost; labelled an estimate (method below) |
| routing policy line | real selector/global-pref/budget-cap state (`formatPolicyString`) |
| routing last pick / kind prefs | `lastPick`; `loadRoutingPreferences().byKind` |
| error lane text | the real error message |
| slash palette rows | `matchCommands()` — real registered commands only |

## TODOs left and why

- **Surprising-routing cases (a) escalation and (c) per-turn cap are gated, not wired.** The
  classifier supports all three brief cases, but only **(b) provider fallback** has a real signal
  today (`fellOverFromRef`). (a) escalation needs the routing scorecard captured per turn (the
  `explain()` set is ephemeral); deliberately deferred to avoid adding latency to the sacred routing
  hot path. (c) per-turn cap is **permanently n/a** — the engine has session/daily/monthly/total
  caps only, no per-turn cap. The line never shows false amber.
- **Savings baseline approximates "most-expensive *eligible*" as "most-expensive *capable*".** The
  per-turn task kind / quality bar isn't persisted, so the baseline uses the priciest registry model
  (which clears every bar). Labelled an estimate (`~`). To make it exact per the brief's letter would
  require persisting the eligible set per turn (a `TurnMeta` change + a hot-path capture) — out of
  scope for "touch core logic as little as possible".
- **Tab strip is fullscreen-only.** Inline mode has no persistent chrome (native scrollback owns the
  screen), so the tabs aren't shown there — by design, matching how `Panel`/`StatusStrip` are also
  fullscreen-only. The Cost/Providers data is still reachable inline via existing commands.

## Assumptions

- "Always-premium" baseline = the single priciest model in the registry, even if the user lacks that
  provider — it's a hypothetical upper bound, which is why the savings is labelled an estimate.
- Low-context threshold = `ctxPct ≥ 85` (≤15% remaining), used consistently by the footer chip and
  the working-strip notice.
- The three untracked test files present at session start (`preferences`/`profiles`/`tokens`) were
  committed as a baseline so the redesign diff stays isolated; they are not my work.

## Deviations from the brief (with reasons)

- **LSP**: left `DESIGN.md`'s roadmap LSP mention in place. It is not a false UI claim (no LSP UI
  exists or ever did), and editing an unrelated roadmap doc is explicitly out of scope. The brief's
  intent (no borrowed LSP furniture in the UI) is met by absence.
- **Composer policy line placed at the top of the box** (under the rule), not the bottom, so the
  input stays bottom-anchored and the cursor/click math barely changes (lower risk).
- **Savings computed without the `explain()` hot-path hook** the blueprint proposed — same honesty,
  less core-logic intrusion and no added routing latency.
- **Effort click-picker removed** from the status bar (effort is no longer shown in the footer per the
  redesign's "keys left, model+cost right"); effort is still set via `/effort` and shift+tab.

## Verification

- `bun run typecheck` clean; `bun test` **745 pass / 0 fail** across 93 files; app launches clean.
- New pure logic is unit-tested: `routing-line`, `policy`, `providers-view`, `working-verb`
  (verb + low-context), `cost-tab` (savings + policy classifier + savings-line), `tabstrip`
  (`tabStripHit` + layout), plus render tests for the new components and the rewritten
  StatusBar/Composer/error-lane/palette.

## Data provenance — anything on screen NOT backed by real data

This list MUST be empty at the end.

(tracked as we go)

## TODOs left and why

(tracked as we go)
