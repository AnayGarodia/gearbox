# Broadsheet — the Gearbox UI design contract

Gearbox's UI is not a chat log. It is **a typeset work ledger with a live
telemetry margin** — the terminal treated as a printed page whose material is
type, space, and alignment. This document is the contract every UI change is
held to.

## The first principle: design for the moment

At any given moment, show exactly what the user needs to know right now, in
the best form for knowing it. Surfaces are derived from moments:

| Moment | What the user needs | The form |
|---|---|---|
| Idle / home | Am I set up? Who answers? What can I do? | Boo (+ shows) · one readiness line (`N accounts ready · pin`) · the centered composer |
| Composing | Who handles this, what it costs | Composer footer: live pick `provider · model` beside the cursor |
| Working | Progress? Doing what now? How to stop? | Boo's head-crop ghost (face = agent state) + shimmer verb, `Ns · esc` right; **history recedes** to faint ink. Narrow frames drop the ghost |
| Reviewing | What changed? Proven? Cost? | The receipt: verdict · files · proof tier; margin carries model · $ · time; ⌃O reopens detail |
| Deciding | What am I approving, options | The consent line: verbatim command, single-key options — the only bright element while pending |
| Auditing | Where did money go? Why this model? | Per-turn margin figures · the meter (ctx gauge · session $) · /cost and /why for depth |

## The three signature ideas

1. **The telemetry margin** (`lines.ts marginLine`, `MARGIN_W = 16`): a page of
   two channels — prose ≤76 cols left, right-aligned figures (model, $,
   duration, ±lines, proof) in a 16-col margin when the content column is
   ≥88 cols; below that the figures fold inline (` · $0.02 · 4s`). Narrative
   left, truth right. Any number belongs in the margin.
2. **Turns are numbered sections** (`lines.ts` user item with `turnNo`): a
   faint hairline between turns, the index (`01`, `02`…) in the brand ink, the
   prompt set bold. No boxes, no background slabs. Command echoes render as
   one small `❯` line.
3. **Turns settle into receipts** (`collapse.ts` + the summary item): live =
   full tool ladder; settled = verdict (bold) · touched files · proof tier in
   the margin, beside the routed line's model · cost. ⌃O expands.

## Brand

Boo is the identity. The default palette ("ghost", `theme.ts dark`) derives
from him: ghost-indigo accent `#8B93F8`, light-indigo heading ink `#B9BDF9`,
warm-paper grays, money in neutral ink (never green — spend isn't "good").
Boo appears exactly twice: the home screen (with the persona shows and the
`/ghost` wardrobe) and the working beat. Never in the flow otherwise.

## Supporting principles

- **One page.** A single centered column holds everything in fullscreen —
  transcript, now-row, queued chips, toasts, consent, composer. Full-width is
  reserved for two chrome rows: the masthead (wordmark · account) and the
  meter (cwd:branch · model · ctx gauge · $). There are no tabs: every fact a
  tab once held already has a home (per-turn margin figures, /why, /account,
  /cost) — a second dashboard for the same fact is a contract violation.
- **Hierarchy is ink, not noise.** Three ink levels (text/dim/faint) + one
  accent + ok/warn/err. Bold marks identity. Backgrounds only on interactive
  surfaces. Attention is directed by *receding* what isn't this moment's
  answer (`recedeLine`), never by adding brightness.
- **Motion is information.** Nothing idles. Allowed: the streaming shimmer,
  margin figures landing, Boo's home shows and one-shot moods, ⌃O expand.
  `GEARBOX_NO_MOTION=1` freezes everything.
- **Decisions look like decisions.** Permission, verify-failure, and
  preference offers share the consent-line pattern (▸ + element bg + accent
  edge + single-key options); shell consent wears the warn edge.
- **Settled work is quiet.** The default screen state reads like a printed
  page.

## Row-count contracts (change ONLY in lockstep, all sites commented)

| Contract | Value | Sites |
|---|---|---|
| HEADER (masthead + rule) | 3 | App.tsx HEADER · Masthead (Masthead.tsx) |
| Composer block | 5 (marginTop + pad + input + pad + footer hint) | Composer.tsx · App footer estimate |
| Consent (permission) footer | 5 | PermissionPrompt.tsx · App `if (perm) footer +=` |
| Meter row | bottom row of the frame (y = termRows) | StatusBar.tsx statusBarHit · App |
| Content cap | 92 cols (76 prose + 16 margin) | App lineWidth · lines.ts MARGIN_W |

## Invariants (tested; never weaken)

Every emitted Line ≤ width. No raw ANSI — Ink color props only. The routing
seam is untouched by UI work. The frame never exceeds the terminal (footer
over-estimated, alt-screen clips). Mouse hit-tests derive from the same
constants as the render (no drift). Diffs: unified with tinted line-number
gutters below 120 cols, side-by-side at ≥120 (`SIDE_BY_SIDE_MIN`); LSP
diagnostics render under the diff they belong to (◆ line:col message).

## Verification

`bun test` + `bun run typecheck`, then the PTY harness at 150x55 / 120x36 /
100x30 / 80x24 (`/tmp/gb-shot.py`, `/tmp/gb-frames2.py`): `scrolled=0
wrapped=0`, masthead/meter/composer present, margin column right-aligned,
narrow widths showing inline-folded figures.
