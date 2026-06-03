# UX backlog — the small things that make a terminal agent feel good

Benchmark: Claude Code, Codex CLI, Gemini CLI. These are the little affordances that
add up to "easy to use." Status is against Gearbox today. Ordered by value/effort
within each group. **P0** = cheap + high-impact, do first.

Legend: ✅ have · ◐ partial · ❌ missing.

## 1. Input & editing

| # | Feature | What it does | Status | Notes |
|---|---------|--------------|--------|-------|
| P0 | **Queue messages while busy** | Type during a running turn; messages queue and send in order when it finishes (CC shows them stacked). | ❌ | Today `submit` drops input while `busy`. High value — you think ahead. |
| P0 | **Paste collapses to a chip** | A big paste shows as `[Pasted 142 lines]` instead of flooding the composer; expands on send. | ❌ | We handle bracketed paste but render it inline. |
| P0 | **Esc-to-edit / rewind** | Esc (or double-Esc) jumps back to edit a previous message and re-run from there, truncating later turns. | ❌ | CC's killer affordance. Maps onto our `msgRef` ledger cleanly. |
| 1 | **Ctrl+R reverse history search** | Fuzzy-search past prompts. | ❌ | We have ↑/↓ history already. |
| 2 | **Vim mode in the composer** | `hjkl`/modes for the input line. | ❌ | Niche but loved; our composer is custom so feasible. |
| 3 | **Newline vs submit clarity** | ⌃J / shift+⏎ newline, ⏎ submit. | ✅ | Already done. |
| 4 | **@-file fuzzy mention** | Tab-completes a file into the message. | ✅ | Have it. |
| 5 | **`!cmd` shell, `#note` memory, `/cmd`** | Prefix routing. | ✅ | All present. |

## 2. Clipboard & selection (the one you hit first)

| # | Feature | What it does | Status | Notes |
|---|---------|--------------|--------|-------|
| P0 | **Don't break native select-to-copy** | We enable SGR mouse reporting for scroll, which hijacks drag-select — you must Option/Shift-drag to copy. CC scrolls without stealing selection. | ◐ | Either gate mouse reporting behind a toggle, or add an explicit copy path (below). The user noticed this immediately. |
| P0 | **Copy last response / code block** | A shortcut (e.g. `Ctrl+Y`, or `y` in a copy mode) that copies the last assistant message or the focused code block to the clipboard. | ❌ | Use OSC 52 so it works over SSH too. |
| 1 | **Copy mode / scrollback selection** | A keyboard-driven mode to select a range of transcript lines and copy. | ❌ | Pairs with the virtualized buffer we already have. |

## 3. Modes & effort

| # | Feature | What it does | Status | Notes |
|---|---------|--------------|--------|-------|
| P0 | **shift+tab mode cycle** | One key cycles normal → auto-accept-edits → plan (CC's loop). | ◐ | We have plan via shift+tab; add an **auto-accept-edits** mode (writes/edits run without the per-call prompt, shell still gated) between normal and plan. |
| P0 | **Effort / thinking modes** | Switch reasoning depth: `think` → `think hard` → `ultrathink`, or a quick toggle. Surfaced as a badge. | ❌ | Maps directly onto **routing** (effort = quality bar) — a `/effort` that nudges the router's bar, plus provider "thinking" budget where supported. |
| 1 | **Per-turn model/effort indicator** | Show which model + effort actually ran each turn. | ◐ | Routing now shows the live pick in the status; extend to a per-turn transcript tag. |

## 4. Feedback & status

| # | Feature | What it does | Status | Notes |
|---|---------|--------------|--------|-------|
| P0 | **Live cost in $** | Running session cost (and per-turn), from real usage × price. | ❌ | We capture usage + have prices in `profiles.ts`. The "ACCOUNT" pillar's first surface. |
| P0 | **Terminal bell / notification on done & on prompt** | Ring/notify when a long turn finishes or when a permission prompt needs you. | ❌ | One escape code; big for stepping away. |
| 1 | **Terminal title reflects state** | `⚙ gearbox — working…` / `— done` in the tab title. | ❌ | OSC 0/2. |
| 2 | **Token/ctx meter** | model · ctx% · tokens. | ✅ | Present in StatusBar. |
| 3 | **Working indicator** | Live "working · Ns", interruptible. | ✅ | Boo + timer. |
| 4 | **Exit cost summary** | On quit, print tokens + $ for the session. | ❌ | Cheap once cost tracking exists. |

## 5. Rendering & output

| # | Feature | What it does | Status | Notes |
|---|---------|--------------|--------|-------|
| P0 | **Syntax highlighting in code blocks** | Color code fences by language. | ❌ | Known TODO — must be Ink `<Text>` spans, never raw ANSI (corrupts width). |
| 1 | **Collapsible / elided long tool output** | Fold a 400-line result behind `[+ 380 lines]`. | ◐ | We truncate the live stream tail; add expand-on-demand. |
| 2 | **Markdown (tables, lists, code, quotes)** | Full markdown render. | ✅ | marked + Ink. |
| 3 | **Colored diffs under edits** | Red/green hunks. | ✅ | Present. |
| 4 | **Collapsible thinking** | Show/hide reasoning. | ❌ | When a provider streams thinking. |

## 6. Session & control

| # | Feature | What it does | Status | Notes |
|---|---------|--------------|--------|-------|
| P0 | **`/doctor` / startup health check** | Verify keys, terminal capabilities, versions; explain what's missing. | ❌ | Cuts first-run confusion. |
| 1 | **`/cost`** | Show the session spend breakdown. | ❌ | Pairs with #4 cost tracking. |
| 2 | **Resume / continue / clear / retry** | Session lifecycle. | ✅ | `/resume`, `-c`, `/clear`, `/retry`. |
| 3 | **`/context`, `/compact`, `/memory`, `/init`** | Context engine controls. | ✅ | Just shipped. |
| 4 | **Slash-command autocomplete palette** | Live filtering as you type `/`. | ✅ | CommandPalette. |
| 5 | **Permission gate (once/always/yolo)** | Approve writes/edits/shell. | ✅ | Present + `--yolo`. |

## Suggested first sprint (all P0, ~each small)
1. Queue-while-busy + paste-as-chip (input feel).
2. Fix selection/copy: gate mouse reporting + `Ctrl+Y` copy via OSC 52.
3. shift+tab adds auto-accept-edits mode; `/effort` tied to the router bar.
4. Live `$` cost in the status + bell on done/prompt.
5. Syntax highlighting (Ink spans).
6. `/doctor`.
