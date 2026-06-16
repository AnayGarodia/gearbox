# Quiet Workshop — the Gearbox UI design contract

Gearbox's UI is **a calm, prose-first coding companion**. The model talks to you
in plain language; the machinery (tools, figures, chrome) recedes to faint marks
beneath it. The screen reads like a conversation, not a dashboard. This document
is the contract every UI change is held to. It supersedes the earlier
"Broadsheet" contract (the typeset-ledger identity with a telemetry margin and
numbered turn sections — deliberately retired: it read as both noisy and sterile).

## The first principle: quiet by default, loud only to decide

At any moment, show exactly what the user needs, in the calmest form that still
reads. The prose is the surface; everything else is a footnote to it. The ONE
exception is a **decision** — a permission, a plan, a question — which becomes
the single bright, contained thing on screen until answered.

| Moment | What the user needs | The form |
|---|---|---|
| Idle / home | Am I set up? Who answers? | Boo splash · one readiness line (`N accounts ready · model`) · centered composer |
| Composing | Who handles this, what it costs | The slim meter line below: `cwd:branch · model · ctx% · $` |
| Working | Progress? Doing what? How to stop? | Boo head-crop ghost (face = state) + shimmer verb + `Ns · esc`; history recedes to faint |
| Reading the flow | What did it do? | Prose, then `⏺ Tool(arg) ⎿ result` footnotes, then a quiet verify line |
| Reviewing a change | What changed? Proven? Cost? | The diff card + the closing verify line: `✓ verified · N passed · model · Ns · $` |
| Deciding | What am I approving? | A rounded decision card with hotkey buttons — the only bordered, bright surface |

## The signature ideas

1. **Prose leads; tools recede.** A turn is your `›` prompt (light-indigo `user`
   ink), the model's plain prose, then tool steps as compact one-liners:
   `⏺ Tool(arg)  ⎿ short result`. The `⏺` dot carries status by COLOR (indigo
   running · green a write landed · red failed · calm indigo a quiet read). No
   per-tool figures, no boxes, no ledger.
2. **No telemetry margin.** The old right-aligned figure column is gone
   (`marginWidth` is always 0). Any number folds inline as a faint ` · fig` tail
   beside the fact it belongs to (`lines.ts marginLine`).
3. **Turns separate by whitespace.** No numbered sections, no `#NN` index, no
   tinted band, no left spine. A single blank line between turns — the page reads
   like a conversation.
4. **Decisions look like decisions.** A blocking decision is the loud moment —
   the only bordered surface in the UI. Two are ROUNDED cards: **permission** (a
   `warn`-amber border for shell, `accent` otherwise) with single-key hotkey
   BUTTONS (`[⏎ Allow] [2 Always] [a Yolo] [esc Deny]`), and **ask_user** (an
   `accent` card with a radio/checkbox option list). The **plan-approval** consent
   is deliberately quieter — not a card but an inline clickable line
   (`▸ plan ready — approve and build it? · /proceed`), because it doesn't block
   the turn. While a card is pending, history recedes so it's the only bright thing.

## Brand

Boo is the identity, used with **restraint**. The default palette ("ghost",
`theme.ts dark`) derives from him: ghost-indigo accent `#8B93F8`, light-indigo
`user` ink `#B9BDF9` for your prompts, warm-paper grays, money in neutral ink
(never green — spend isn't "good"). Boo appears exactly twice: the home splash
and the working beat. Never in the flow otherwise. The accent is for
interactive/now ONLY (live composer, selected row, a decision card's border, a
clickable zone) — never prose, filenames, or status glyphs.

## Chrome: two slim lines, nothing more

Fullscreen stays the substrate (Conductor tabs, virtualized viewport, scrollbar,
mouse all survive) but it FEELS inline. Chrome is exactly two single rows:

- **Top** (`Masthead.tsx`): `gearbox` wordmark · account, plus the clickable
  Conductor tab cells, under one hairline rule. No full-width color bar (the old
  provider-hue `▔` band is gone — calm over branding).
- **Bottom** (`StatusBar.tsx`): `cwd:branch · model · ctx% · $`, with click zones
  (model→picker, $→/usage, ctx→/context) and an `esc` hint when interruptible.

## Supporting principles

- **One page.** A single centered column holds the transcript, decision cards,
  queued chips, toasts, and composer. The two chrome rows are the only
  full-width elements. No second dashboard for a fact that already has a home.
- **Hierarchy is ink, not noise.** Three ink levels (text/dim/faint) + one
  accent + ok/warn/err. Bold marks identity. Borders ONLY on decision cards;
  background tints only on diffs/code/panels. Attention is directed by RECEDING
  what isn't this moment's answer (`recedeLine`), never by adding brightness.
- **Motion is information.** Nothing idles. Allowed: the streaming shimmer, Boo's
  home shows and one-shot moods, ⌃O expand. `GEARBOX_NO_MOTION=1` freezes it.
- **Settled work is quiet.** The default screen reads like a calm conversation.

## Row-count contracts (change ONLY in lockstep, all sites commented)

| Contract | Value | Sites |
|---|---|---|
| HEADER (masthead + rule) | 3 | App.tsx HEADER · Masthead.tsx |
| Composer block | 4 + capped input rows | Composer.tsx · App footer estimate |
| Permission card | 7 | PermissionPrompt.tsx · App `if (perm) footer += 7` |
| Ask card | options + 6 | AskPrompt.tsx askPromptRows · App footer |
| Meter row | bottom row of the frame | StatusBar.tsx · App |

## Invariants (tested; never weaken)

Every emitted Line ≤ width. No raw ANSI — Ink color props only. The routing seam
is untouched by UI work. The frame never exceeds the terminal (footer
over-estimated, alt-screen clips). Mouse hit-tests derive from the same constants
as the render (no drift). Diffs: unified with tinted line-number gutters below
120 cols, side-by-side at ≥120 (`SIDE_BY_SIDE_MIN`); LSP diagnostics render under
the diff they belong to (`◆ line:col message`). The `⏺`/`⎿` tool glyphs and the
`›` turn glyph live in `theme.ts glyph`.

## Verification

`bun test` + `bun run typecheck`, then eyeball the flow with a render harness
(itemsToLines over a sample transcript) and a live session at 150x55 / 100x30 /
80x24: prose-first turns, `⏺/⎿` tool footnotes, no margin column, decision cards
rendering as rounded bordered buttons, every line within width.
