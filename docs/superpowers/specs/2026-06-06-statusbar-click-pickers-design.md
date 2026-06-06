# Status-bar click pickers — model & effort

## Goal

Let the user open a floating picker by **clicking the model label or the effort
label** in the status bar, as an additional entry point alongside the existing
`/model` and `/effort` slash commands (which stay unchanged).

Two separate click zones: model label → model picker, effort label → effort picker.

## Constraints

- **Fullscreen only.** SGR mouse reporting is grabbed only in fullscreen mode
  (same reason wheel-scroll is fullscreen-only). Inline mode has no click events;
  the labels stay informational and `/commands` remain the path there.
- No new dependencies. Reuse the existing `CommandPalette` component and the
  existing model/effort row data.
- Keep the routing seam clean — selecting a row submits `/model X` / `/effort Y`,
  reusing the exact command path the slash picker already uses.

## Hit detection

Two sub-problems: which terminal row the status bar is on, and which columns are
the model vs effort labels.

**Row.** The footer is a variable stack (Working, activity rail, queued chips,
mode notice, search, copied notice). Everything variable is *above* the status
bar; the status bar, palette box, and composer are always the bottom three. So
measure up from the composer, which already computes its own first row:

```
statusBarRow = firstInputRow - PALETTE_ROWS - 1
```

where `firstInputRow = rows - composerLineCount + 1` (already used by
`composerOffset`). Robust to every conditional notice above it.

**Columns.** Extract a pure helper `statusBarLayout({ model, effort, mode })` that
returns `{ modelZone: [start, end], effortZone: [start, end] | null }` in 0-based
columns, accounting for `paddingX={1}` and the optional `mode` prefix. Single
source of truth: `StatusBar` renders from it and the mouse handler hit-tests
against it, so rendered position and clickable position cannot drift.

## State

In `App.tsx`:

```
quickPicker: null | "model" | "effort"   // which picker is open
quickPickerIndex: number                  // selected row
```

Plus `useRef` mirrors for the mouse/key handlers (existing `paletteIndexRef`
pattern).

## Rendering

Reuse `CommandPalette` (already takes `rows: PaletteRow[]`), rendered in the
footer just above the status bar when `quickPicker` is set. Row data already
exists:

- `"model"` → `commandPickerRows("/model")` (API registry + CLI-subscription
  models, includes the `auto` row)
- `"effort"` → `effortRows()` (already clamps to what the active model supports;
  empty for non-reasoning models like haiku)

If `effortRows()` is empty, clicking the effort label flashes a brief
"no effort for this model" status and does not open.

## Event flow

**Mouse** (existing SGR handler in `App.tsx`):

- click in `modelZone` → toggle `quickPicker` to `"model"`
- click in `effortZone` → toggle to `"effort"`
- click elsewhere while open → close

**Keyboard** (gated `if (quickPicker)` near the top of `useInput`, before normal
handling; gated on `!busy` like `cycleMode`):

- ↑/↓ → move `quickPickerIndex`
- Enter → `submit(rows[index].value)` then close — reuses the slash-command path,
  so model-switch notices, effort clamping, and subscription handling all work
- Esc / any other key → close

## Testing

- Pure unit test for `statusBarLayout()`: zones correct with/without the mode
  prefix, with/without the effort label, varying model-name length.
- Existing `StatusBar` render behavior unchanged.
- Mouse coordinate → zone mapping is covered by the pure helper test; the
  `App.tsx` wiring follows existing tested patterns.

## Out of scope

- Inline-mode clickability.
- Clicking any other status-bar field (branch, tokens, cost, ctx).
- A combined "quick settings" picker (kept as two separate zones by request).
