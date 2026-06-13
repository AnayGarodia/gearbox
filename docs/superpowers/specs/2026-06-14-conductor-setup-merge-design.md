# Conductor: per-tab setup scripts + merge/archive polish

Enhance the existing tab system (each tab is already a git worktree) with two
Conductor-style capabilities: a setup script that bootstraps a new tab's
worktree, and a reviewed merge that archives the worktree when it lands.

## Decisions (from brainstorming)

- Scope: tabs stay the unit. v1 = setup script + merge/archive polish. NOT
  files-to-copy, NOT per-tab ports.
- Setup config: a committable `.gearbox/setup` shell script (matches the
  `.gearbox/*` file convention; tracked so it rides into every worktree).
- Setup timing: **background, never blocks** the tab.
- Merge: show the tab's diff in a confirm panel before landing.
- Archive: after a clean merge, remove the worktree, keep the branch ref.
- UI: clickable-first (a merge cell in the masthead tab bar, a setup glyph on
  the tab cell); slash commands remain the keyboard fallback.
- Safety: NO separate trust gate. Gearbox already runs `.gearbox/plugins/*.ts`
  (arbitrary code) with no prompt, so opening a repo already trusts its
  `.gearbox/` content; gating only `setup` would be inconsistent. A unified
  `.gearbox/` trust model (plugins + mcp + setup) is a separate, larger piece.

## Components

- `src/setup.ts` (new): `hasSetup(root)` (pure: does `.gearbox/setup` exist) and
  `runSetup(worktreeDir)` → `Promise<{ ok; output }>` (wraps `runShellStream`
  with `cwd = worktreeDir`, sandbox off — it's user-authored project config like
  a plugin). Detection is unit-tested.
- `src/ui/tabbar.ts`: `TabRow` gains `setup?: "running" | "failed"`; `tabMark`
  precedence becomes needsInput ⚠ > setupFailed ✗ > done ✓ > busy ● >
  setupRunning ⟳. A `mergeable` flag adds a clickable `⤴` merge cell to
  `tabBarSegments`/`tabBarHit` (returns `{ kind: "merge" }`).
- `src/ui/components/Conductor.tsx`: `TabState` gains `setup` + `setupNote`.
  `create()` — after a real worktree is made and `hasSetup(home)` — sets
  `setup: "running"` and fires `runSetup(wtDir)` (not awaited); on settle updates
  that tab's `setup` to `undefined`/`"failed"` and `setupNote`. `tabRowsOf`
  passes `setup` and `mergeable` into rows.
- `src/ui/App.tsx`: new `setupNote` prop → an effect pushes it as a notice once
  when it changes (the only channel Conductor→active-tab feedback needs); the
  masthead mouse handler dispatches a `merge` tab-bar hit to the merge flow.
- `src/ui/panel.ts` + `Panel.tsx`: new panel kind `merge-confirm` (diff text +
  the merge params); renders the diff scrollable with a `⏎ merge · esc cancel`
  footer.
- `src/ui/command-handler.ts`: `/tab merge` opens the confirm panel (was an
  immediate merge); confirming runs commit → merge into base → `worktreeRemove`
  (archive) → switch to base. Conflict aborts cleanly (existing path), nothing
  archived.

## Data flow

new tab → Conductor.create() makes worktree → if hasSetup, mark running + fire
runSetup(wtDir) in background → on done, setTabState updates setup glyph +
setupNote → active App surfaces the note once. Merge: click `⤴` (or /tab merge)
→ command-handler builds the diff → merge-confirm panel → ⏎ → commit+merge+
archive → base tab.

## Error handling

- No `.gearbox/setup` → no-op.
- Setup fails → tab stays open, cell shows ✗, setupNote carries the tail of the
  output; non-fatal.
- Merge conflict → `git merge --abort`, panel shows the conflict notice, no
  archive.
- `worktreeRemove` fails post-merge → keep the tab, notice; merge already landed.

## Testing

- `setup.ts`: `hasSetup` true/false by file presence.
- `tabbar.ts`: `tabMark` precedence incl. setup states; `tabBarSegments`/
  `tabBarHit` include and resolve the merge cell.
- `panel.ts`: merge-confirm open/scroll/confirm reducer.
- Conductor: setup-state transitions with a mock runner (running → cleared/
  failed); `tabRowsOf` carries setup + mergeable.
