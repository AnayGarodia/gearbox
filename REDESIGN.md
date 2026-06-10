# UI rebuild brief — opencode-style Gearbox

Synthesized 2026-06-10 from (a) a source-level dossier of opencode's TUI
(Go/Bubble Tea v0.6.0 + the OpenTUI v1 era) and (b) a community-evidence sweep
(reddit, HN, GitHub issues across Claude Code / opencode / aider / Crush /
Gemini CLI / Codex). This is the contract for the rebuild.

## Why users prefer opencode's UI (evidence-ranked)

1. **No flicker/tearing during streaming** — the #1 complaint about every
   Ink-style harness ("Literally no other CLI tool has these issues: opencode,
   codex, gemini" — HN). Gearbox already has the virtualized buffer + coalesced
   deltas; the rebuild must keep and harden that.
2. **Selection/copy/scrollback that work** — alt-screen done WELL (independent
   scroll regions) is loved; mouse-grab breaking selection is hated. Keep
   inline mode first-class; in fullscreen keep wheel scroll but document the
   modifier-selection path; add transcript export/open-in-$EDITOR as the
   escape hatch.
3. **Tool-output middle tier** — collapsed one-line stubs by default,
   one-keystroke expansion to full detail. Neither "Read 3 files" opacity nor
   JSON floods.
4. **Always-visible model + cost + context%** — a thin status readout. Gearbox
   already leads here (routing line, /usage strip); restyle, don't remove.
5. **The opencode look** — centered width-capped column, flat layered
   backgrounds, colored left-spine blocks, no box borders. "Treats you like a
   developer."

## The opencode visual language (rebuild targets)

- **Layout**: one centered column, content capped at `min(termWidth, 86)`
  cols; generous side margins on wide terminals. Transcript viewport above,
  composer pinned at bottom, full-width status bar at the very bottom.
- **Three background layers** (dark): page `#0a0a0a` → panel `#141414`
  (message/tool blocks) → element `#1e1e1e` (input, chips, modal elements).
  Grouping by background shade, NOT by drawn borders.
- **Signature block**: thick `▌` LEFT spine carrying semantic color + panel
  background + padding 1,2. User message = blue spine on panel; assistant =
  NO block, bare markdown on page bg (quiet asymmetry); tool = panel with
  invisible spine, warning-orange both-edges while a permission is pending.
- **Collapsed tool stubs**: `∟ Edit src/foo.ts` corner-glyph lines appended
  under assistant text; `/details` (or ctrl+o) toggles full blocks (diffs,
  first-6-lines reads, console-block shell output).
- **Composer**: thick left+right border in gray, element bg, bold `>` prompt
  (swaps to `!` + blue border in bash mode); footer line under it: hint left
  (`enter send` / `working ⋯ esc interrupt`), `Provider Model` right.
- **Status bar**: panel bg full width; left wordmark chip + version +
  `~/path:branch`; right mode/agent chip (uppercase, thick left border,
  accent). Session header: title as H1 + right-aligned `tokens/ctx% · $cost`.
- **Palette** (default dark): text `#eeeeee`, muted `#808080`, primary peach
  `#fab283`, secondary blue `#5c9cf5`, accent purple `#9d7cd8`, error
  `#e06c75`, warning `#f5a742`, success `#7fd88f`. Keep Gearbox's multi-theme
  system; re-base the default theme on this language.
- **Diffs**: unified < 120 cols, side-by-side ≥ 120; tinted line-number
  gutters (`#1b2b34`/`#2d1f26`), full-row add/remove tints (`#20303b`/
  `#37222c`), LSP diagnostics in red under the diff.
- **Motion**: shimmer verbs on pending tools ("Reading file..."), ellipsis
  spinner in the composer footer — not in the transcript. Plain text, no
  cutesy verbs (the "Gittifying..." backlash is real).

## What Gearbox keeps (already ahead of the field)

- Virtualized line buffer + WeakMap memoization + delta coalescing (the
  anti-flicker machinery) — the rebuild restyles `lines.ts` output, it does
  not replace the renderer.
- Inline mode as the selection-native option; fullscreen default.
- The routing provenance line, /why scorecard, /usage strip, cost-in-status —
  community evidence says always-on cost visibility is a top-5 want.
- Prompt queueing, fuzzy pickers, session resume, permission gate semantics.
- Boo stays as the working indicator (compact state ghost), restyled to sit
  inside the composer-footer hint slot rather than the transcript flow.

## Build sequence

1. `theme.ts`: add the layered-background keys (page/panel/element) + the
   opencode-derived default dark palette; all themes gain the 3 layers.
2. `lines.ts` + `Transcript.tsx`: width-capped centered column; user-message
   spine blocks; bare assistant markdown; block info lines (model · time).
3. Tool rendering: collapsed `∟` stubs + `/details` toggle; expanded panel
   blocks per tool kind; permission state = warning edges on the block.
4. Composer + footer line + status bar restyle.
5. Session header (title + tokens/ctx/cost readout).
6. Diff renderer: gutter tints + side-by-side ≥ 120 cols.
7. Modals/panels: restyle Panel.tsx to the element-layer language; live-
   preview theme picker already exists — re-skin.

Invariants that must not regress: every line ≤ width (tested), no raw ANSI in
Ink, routing seam untouched, all existing render tests pass (update snapshots
deliberately, not incidentally).
