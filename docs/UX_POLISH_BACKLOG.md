# Gearbox UX polish backlog — grounded in Claude Code

A diff between **Claude Code's documented interactive-mode features** (researched June
2026, sources at the bottom) and **what gearbox does today** (verified against the
codebase). Every item names the Claude Code behavior it's based on, gearbox's current
state, the proposal, the file most likely to change, and effort (S ≤ ~1h · M a few hours
· L a day+).

**Already at parity (don't re-add):** full readline editing + word jumps + kill bindings
(`input.ts`), `⌃R` reverse history search, `⌃O` expand-all tool output/diffs, esc-esc
rewind of the last turn, per-project prompt history (`session.ts` `history.json`),
shift+tab mode cycle, multi-line via `⌃J`/shift+⏎, `⌃Y` copy reply, `/compact`,
`/context`, `/cost`, `/theme`, `/vim`, `/init`, `/memory`, `!` shell, `@` mentions, vim
mode. The gaps below are what's missing.

---

## A. Autocomplete & pickers — the core ask

Claude Code: typing `/` opens a filtering dropdown you navigate with arrows; the `@`
trigger gives file-path autocomplete; a grayed-out **prompt suggestion** appears in the
input that you accept with Tab/→.

1. **Arrow-select the `/command` palette + Enter/Tab to autofill.** *CC:* "Type `/` … to
   filter," navigate the dropdown, Enter/Tab to choose. *Gearbox:* GAP — `CommandPalette`
   is display-only; `↑/↓` move text lines / history, nothing selects or fills. *Where:*
   `App.tsx` (palette-selection state, intercept arrows when open), `CommandPalette.tsx`.
   *Effort:* M. **(Your example.)**

2. **`@file` palette: arrow-select + autofill.** *CC:* `@` triggers file-path
   autocomplete. *Gearbox:* PARTIAL — Tab inserts the **first** match only, no list nav.
   *Where:* `App.tsx`, `FilePalette.tsx`. *Effort:* S (shares the picker from #1).

3. **Tab cycles `@file` matches.** *CC:* terminal-style tab completion. *Gearbox:* PARTIAL
   — Tab always takes match[0]. *Where:* `App.tsx` Tab handler. *Effort:* S.

4. **Grayed-out prompt suggestion on session open.** *CC:* a dim example drawn from your
   git history appears in the empty input. *Gearbox:* GAP. *Where:* `App.tsx` welcome,
   `git.ts` (recent files/commits). *Effort:* M.

5. **Follow-up suggestions after a reply.** *CC:* after Claude responds, a dim suggested
   next step appears; typing dismisses it. *Gearbox:* GAP. *Where:* `App.tsx` post-turn,
   reuses #6's render. *Effort:* M.

6. **Accept-suggestion mechanism (ghost text).** *CC:* Tab or → places the suggestion,
   Enter submits, any keystroke dismisses. *Gearbox:* GAP — needed by #4/#5. *Where:*
   `Composer.tsx` (trailing dim span), `input.ts` (→/Tab at end-of-input accepts).
   *Effort:* M.

7. **Argument completion.** *CC:* commands complete their arguments. *Gearbox:* GAP —
   `/model `, `/theme `, `/account `, `/effort ` offer no value completion. *Where:*
   `commands.ts` (per-command arg providers), `App.tsx`. *Effort:* M.

8. **`!` shell-history tab completion.** *CC:* in shell mode, "type a partial command and
   press Tab to complete from previous `!` commands in the project." *Gearbox:* GAP.
   *Where:* `App.tsx`, a small `!`-history store. *Effort:* S.

---

## B. Long prompts & external editing

9. **Open the prompt in `$EDITOR` (`⌃G` / `⌃X ⌃E`).** *CC:* edit your prompt in your
   default editor — invaluable for multi-paragraph input. *Gearbox:* GAP (no EDITOR
   integration anywhere). *Where:* `App.tsx` (spawn `$VISUAL`/`$EDITOR` on the draft),
   `shell.ts`. *Effort:* M.

10. **Open the transcript in `$EDITOR` (`v`).** *CC:* dump the conversation to a temp file
    and open it. *Gearbox:* GAP (only `/export` to a path). *Where:* `App.tsx`. *Effort:* S.

11. **`\` + Enter newline.** *CC:* the universal "works in all terminals" continuation.
    *Gearbox:* GAP — only `⌃J`/shift+⏎/alt+⏎. *Where:* `input.ts`. *Effort:* S.

---

## C. Kill-ring & readline depth

12. **Kill-ring + yank.** *CC:* `⌃K`/`⌃U`/`⌃W` store deleted text; `⌃Y` pastes it back.
    *Gearbox:* GAP — kills discard the text, and `⌃Y` is already "copy last reply"
    (conflict). Add a kill-ring with yank on a free binding (e.g. `⌥Y`). *Where:*
    `input.ts`, `App.tsx`. *Effort:* M.

13. **`⌥Y` cycle paste history.** *CC:* after a yank, cycle older kills. *Gearbox:* GAP
    (after #12). *Where:* `input.ts`. *Effort:* S.

14. **`⌥B`/`⌥F` word-nav letter bindings + `⌃P`/`⌃N` history.** *CC:* readline-native
    aliases. *Gearbox:* PARTIAL — has arrow word-jump and arrow history, not these
    letter/ctrl aliases. *Where:* `input.ts`. *Effort:* S.

15. **Esc saves the cleared draft to history.** *CC:* clearing with esc-esc "saves the
    draft to history so Up recalls it." *Gearbox:* GAP — esc clears and discards. *Where:*
    `App.tsx` interrupt handler. *Effort:* S.

---

## D. Transcript navigation

16. **`{` / `}` jump to previous / next user prompt.** *CC:* vim-paragraph motion through
    the transcript. *Gearbox:* GAP — only line scroll + PgUp/Dn. *Where:* `App.tsx`
    (anchor offsets from `lines.ts`). *Effort:* M.

17. **`[` dump conversation to native scrollback.** *CC:* writes the full conversation to
    the terminal's scrollback so `Cmd+F` / tmux copy-mode can search it. *Gearbox:* GAP
    (fullscreen owns the screen; `/export` writes a file instead). *Where:* `App.tsx`,
    `cli.tsx`. *Effort:* M.

18. **`⌃L` redraw.** *CC:* forces a full redraw to recover a garbled display. *Gearbox:*
    GAP. *Where:* `App.tsx`. *Effort:* S.

19. **`⌃D` exits on an empty composer (EOF).** *CC:* EOF exits the session. *Gearbox:* GAP
    — `⌃D` is forward-delete and does nothing at end-of-empty-input. *Where:* `App.tsx`
    (the `input.ts` reducer already returns `none` at EOF for the caller to handle).
    *Effort:* S.

---

## E. Footer, status & ambient feedback

20. **PR review status in the footer.** *CC:* a clickable `PR #446` with a colored
    underline (green approved / yellow pending / red changes / gray draft), refreshed
    every 60s via `gh`. *Gearbox:* GAP — status bar shows the branch only. *Where:*
    `StatusBar.tsx`, `git.ts` (+ `gh` calls). *Effort:* M.

21. **Context-pressure color + nudge.** *CC:* `/context` visualizes usage; warns before
    limits. *Gearbox:* PARTIAL — `% ctx` is plain text. Turn it amber ≥70% / red ≥90%
    with a one-time "`/compact`?" nudge. *Where:* `StatusBar.tsx`, `App.tsx`. *Effort:* S.

22. **Session recap after stepping away.** *CC:* a one-line recap of the session generated
    in the background once you've been idle ~3 min; `/recap` on demand. *Gearbox:* GAP.
    *Where:* `App.tsx` (idle timer + a cheap summary call), `commands.ts`. *Effort:* M.

23. **Live routed-model readout.** *CC:* model is always visible; `⌥P` switches it.
    *Gearbox:* PARTIAL — surface "routing → haiku" the instant the pick is made, not just
    post-hoc in the status bar. *Where:* `App.tsx` (`onPick`), `Working.tsx`. *Effort:* S.
    *(Protects the routing USP.)*

24. **Task-list overlay (`⌃T`).** *CC:* a pending/in-progress/done checklist in the status
    area that survives compaction. *Gearbox:* GAP — the agent loop surfaces no todos.
    *Where:* `agent/run.ts` (emit a todo event), `App.tsx`, a `TaskList.tsx`. *Effort:* L.

---

## F. Hotkeys for things that today need a command

25. **`⌥P` switch model without clearing the prompt.** *CC:* exactly this. *Gearbox:* GAP
    — `/model` only. *Where:* `App.tsx` (hotkey → model picker reusing #1). *Effort:* S.

26. **`⌥T` cycle effort / thinking.** *CC:* `⌥T` toggles extended thinking. *Gearbox:* GAP
    — `/effort` only; map a hotkey to cycle fast·balanced·max. *Where:* `App.tsx`.
    *Effort:* S.

27. **Arrow-navigable permission dialog.** *CC:* Left/Right cycle options in permission
    dialogs. *Gearbox:* PARTIAL — `PermissionPrompt` is number keys (1/2/3/esc). Add
    ↑/↓ + Enter selection on top. *Where:* `PermissionPrompt.tsx`, `App.tsx`. *Effort:* S.

28. **Paste an image (`⌃V`) as an `[Image #N]` chip.** *CC:* inserts a positional image
    reference for multimodal models. *Gearbox:* GAP (text-only today). Lower priority
    until image routing exists, but cheap to stub. *Where:* `App.tsx`, `agent/run.ts`.
    *Effort:* M.

---

## G. Missing commands worth adding

29. **`/diff`** — show the working-tree / pending-edit diff in one view. *CC* has it;
    gearbox shows diffs only inline under edits. *Where:* `commands.ts`, `diff.ts`. *S.*

30. **`/btw <q>`** — a side question answered from current context that does **not** enter
    the conversation history. Distinctive CC feature; great for "what was that file
    again?". *Where:* `App.tsx` (ephemeral overlay), `agent/run.ts`. *M.*

31. **`/rewind` menu (checkpointing).** *CC:* restore code + conversation from any earlier
    point. *Gearbox:* PARTIAL — esc-esc rewinds only the **last** turn; no menu, no code
    restore. *Where:* `App.tsx`, `session.ts` (snapshots). *L.*

32. **`/fork`** — branch the current conversation into a new session. *Where:*
    `session.ts`, `App.tsx`. *S.*

33. **`/rename`** — name the current session (gearbox auto-titles). *Where:* `session.ts`,
    `App.tsx`. *S.*

34. **`/keybindings`** — remap shortcuts via a config file. *CC* has it; gearbox keys are
    hardcoded in `input.ts`/`App.tsx`. *Where:* a `keybindings.ts` + `prefs`. *L.*

35. **`/doctor` (or `/status`)** — one screen: which providers have keys, model
    reachability, versions, config paths. *Where:* `commands.ts`, `accounts/*`. *M.*

36. **`/add-dir`** — add another working root for `@`/search. *Where:* `files.ts`,
    `tools.ts`, `App.tsx`. *M.*

---

## H. History-search depth

37. **`⌃R` scope cycling + match highlight.** *CC:* `⌃S` cycles scope (session / project /
    all) and highlights the matched substring. *Gearbox:* PARTIAL — reverse search exists
    but is single-scope, no highlight. *Where:* `history.ts`, `App.tsx`. *Effort:* S.

38. **Prefix history search.** *CC/zsh:* type a few chars, then `↑` walks only entries
    with that prefix. *Gearbox:* GAP — `↑` is raw chronological. *Where:* `history.ts`
    (`navHistory` gains a prefix), `App.tsx`. *Effort:* M.

---

## Recommended sequencing

**Wave 1 — the interactive picker (your example, highest leverage).**
#1 arrow-select → #2 file parity → #3 tab-cycle → #25 `⌥P` model picker reuse. One
coherent change to the composer/palette layer that everything else builds on.

**Wave 2 — ghost-text suggestions + ambient feedback (cheap, big "feel" payoff).**
#6 accept mechanism → #4 open suggestion → #5 follow-ups; plus #21 ctx color, #23 live
routed model, #15 esc-saves-draft, #18 `⌃L`, #19 `⌃D` exit.

**Wave 3 — editing & history depth.**
#9 `$EDITOR`, #12 kill-ring/yank, #11 `\`+⏎, #14 readline aliases, #38 prefix history,
#37 `⌃R` scope, #8 `!` history completion, #7 arg completion.

**Wave 4 — transcript power.**
#16 `{`/`}` jump, #17 `[` scrollback dump, #10 `v` editor, #29 `/diff`, #30 `/btw`,
#27 permission arrows.

**Wave 5 — bigger plays.**
#20 PR status, #22 session recap, #24 task list, #31 `/rewind` menu, #34 `/keybindings`,
#35 `/doctor`, #28 image paste, #32 `/fork`, #33 `/rename`, #36 `/add-dir`.

Waves 1+2 (~12 items) deliver most of the "feels like Claude Code" jump for a few days of
work; the rest is incremental depth.

---

## Sources

- [Claude Code — Interactive mode (official docs)](https://code.claude.com/docs/en/interactive-mode.md)
- [Claude Code — CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Claude Code Interactive Mode: Complete Reference (claudefa.st)](https://claudefa.st/blog/guide/mechanics/interactive-mode)
- [Tab-completion for slash commands — anthropics/claude-code #40538](https://github.com/anthropics/claude-code/issues/40538)
- [Inline autocomplete for /slash commands — anthropics/claude-code #9750](https://github.com/anthropics/claude-code/issues/9750)
- [How to use Vim in Claude Code (HAMY)](https://hamy.xyz/blog/2026-03_vim-mode-claude-code)
