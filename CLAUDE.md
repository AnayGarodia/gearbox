# Gearbox — project guide

Gearbox is a multi-provider coding harness for the terminal: a beautiful, simple terminal agent that reads/writes code and runs commands, talking to any provider (Anthropic, OpenAI, Google, DeepSeek) through one clean loop.

**The point of the project (coming soon, do not break it):** intelligent per-task *model routing* — automatically picking the right model for each task across every provider and account you pay for. v0.1 is the harness only; routing lands on top. See `DESIGN.md` for the full vision and `experiments/FINDINGS.md` for the validation behind it.

## The one rule that matters

**Keep the routing seam clean.** The agent must never hardcode a model. It asks a `ModelSelector` for the model to use. Today the selector returns a fixed default; soon it becomes the router. Concretely:

- `src/model/selector.ts` — the seam. `select(task) => ModelChoice`. Do not bypass it.
- `src/providers.ts` — maps a provider+model id to an AI SDK model instance. Already multi-provider. Adding a model is data, not code.
- Every model call captures token usage (`src/agent/run.ts`) so the future cost engine has data. Do not drop usage.
- The UI consumes a normalized `AgentEvent` stream (`src/agent/events.ts`), never the AI SDK's raw types. This decouples the UI from the provider layer and from routing.

If you find yourself writing `anthropic('claude-...')` anywhere outside `providers.ts`, stop — route it through the selector.

## Layout

```
src/
  cli.tsx            entry point; renders the Ink app
  config.ts          minimal config (default model, provider from env)
  providers.ts       provider+model id -> AI SDK model  (multi-provider; contextWindow per model)
  model/selector.ts  THE ROUTING SEAM (fixed model now, router later)
  commands.ts        slash-command metadata + pure helpers (fuzzy model match, /help, model list)
  tools.ts           read / write / edit / list / run_shell  (AI SDK tools)
  agent/
    events.ts        AgentEvent — normalized stream the UI consumes
    run.ts           real agent loop (AI SDK streamText -> AgentEvent), abort-aware
    mock.ts          scripted demo stream (runs with no API key; used by tests)
  ui/
    theme.ts         colors + glyphs (the look)
    input.ts         pure key→action reducer for the composer (tested)
    history.ts       pure ↑/↓ prompt-history nav (tested)
    useTerminalSize.ts  reactive width on resize (everything reflows)
    git.ts           current branch for the status line
    App.tsx          the Ink app: state, useInput dispatch, commands, turns
    components/      Banner, Transcript, Composer, CommandPalette, StatusBar
test/                pure-logic + render tests (ink-testing-library); no keys
DESIGN.md            full product vision (routing, requirements, UX)
experiments/         prototypes that validated the architecture
```

The composer is custom (Ink `useInput` + `src/ui/input.ts`), not a third-party widget — full control over the cursor, ↑/↓ history, and esc-to-interrupt, with no focus/remount fragility. **Multi-line**: ⌃J (or shift/alt+⏎) inserts a newline, ⏎ submits; ↑/↓ move between lines and fall through to history at the top/bottom line; bracketed paste (enabled in `cli.tsx`) inserts multi-line text literally (CR normalized, paste markers stripped) instead of submitting per line. `caretPos()` is the shared line/col helper. Keys: ⏎ send · ⌃J newline · ↑↓ line/history · ← → / ⌃a / ⌃e cursor · tab complete @file · shift+tab plan · esc interrupt · ⌃c quit.

**Sessions** (`src/session.ts`): conversations persist per-project under `~/.gearbox/sessions/<slug>/` (`GEARBOX_HOME` overrides). Each record holds provider-neutral `messages` + the UI `items` + **per-turn `{model, usage, at}`** (routing/cost data — the record is deliberately not single-model). `gearbox --continue`/`-c` resumes the latest; `/resume [n]` lists/loads in-app; `/clear` starts a fresh session. Prompt history persists across runs (`history.json`). Saving is best-effort (never crashes the app); skipped in demo mode.

Features: full markdown via **marked** (parse, `marked.lexer`) + **Ink** (render) in `Markdown.tsx` — headings, bold/italic/inline-code, tables, ordered+nested lists, blockquotes, code blocks. NO foreign ANSI in Ink (cli-highlight/marked-terminal were tried and removed — they corrupt Ink's width/wrapping; render marked's token tree as Ink elements instead). Markdown gets a `width` prop (threaded App→Transcript→Markdown) for table/rule sizing. Colored diffs under edits (`src/diff.ts`, edit/write tools return `{summary,diff}`), plan mode (read-only tools + plan prompt; `/plan` or shift+tab), `!cmd` runs a shell command directly (`src/shell.ts`), `@file` mentions (fuzzy picker `src/ui/mention.ts`+`files.ts`; expanded into the model message on send), live "working · Ns" timer.

**Boo (the mascot).** A pixel ghost, now **parametric** (`src/ui/ghost/engine.ts`, ported from a Claude Design handoff). A 20×20 pixel sprite composited from composable layers — body (palette) + face (eyes/mouth) + accessory + persona + a frame-driven overlay (tears/dots/confetti/Z's/sparkle/hearts) — then FOLDED into half-block cells (`▀`/`▄`, top px → `t`/glyph color, bottom px → `b`/bg). `renderGhost(cfg)` is the source of truth for the **default blocks path**; it's pure + memoized. The data: 13 faces (`FACES`), 9 palettes (`PALETTES`), 6 accessories, 9 personas (personas/accessories ported but not yet surfaced in the live UI). Ink `color`/`backgroundColor` props only, NEVER raw ANSI (corrupts Ink's width math). PNG paths are **opt-in** via `GEARBOX_GHOST`:

- `GEARBOX_GHOST=kitty` — real PNG via kitty graphics Unicode placeholders (`U+10EEEE`, fg encodes image id, diacritics encode row/col; PNGs transmitted once in `cli.tsx`). NOTE: the placeholder protocol is young and mis-rendered (squished) in Ghostty during testing — kept opt-in until that's solved.
- `GEARBOX_GHOST=iterm` — OSC 1337 splash banner (iTerm2/WezTerm).

`detectImageMode()` returns `blocks` unless `GEARBOX_GHOST` opts in. Baked PNGs live in `src/ui/mascot-png.ts`; `bun run scripts/ghost-preview.ts` previews the parametric engine (splash + all faces + the in-flow state crops). **Boo is animated but deliberately calm** on the blocks path (`AnimatedGhost` in `Mascot.tsx`): one shared, unhurried 240ms tick (leaf-local `useTick`, never lifted to App root); talk + overlays advance at half that (~480ms). There is NO idle bob/float and NO splash sparkle — motion is a quiet sign of life, not fidgeting (the splash just blinks every ~6s; in-flow only the state-meaningful overlay/talk moves). `GEARBOX_NO_MOTION=1` freezes to frame 0. `/ghost [mood]` cycles the skin (`skinToCfg` maps it to a cfg; `shades` is the cool face + shades accessory).

**Layout: fullscreen, virtualized scroll, full width.** The app owns the alternate screen (`cli.tsx`: `\x1b[?1049h`, restored on exit; `GEARBOX_INLINE=1` forces plain inline flow). The transcript is a **virtualized line buffer**: `src/ui/lines.ts` (`itemsToLines`) flattens items into styled `Line`s (markdown→lines, wrapping, diffs) — INVARIANT: every line ≤ width (tested), so nothing overflows. `App` renders only the visible window via `Viewport` (`src/ui/components/Viewport.tsx`) at a computed `transcriptHeight = rows − header − footer` (footer over-estimated so the frame never exceeds the screen; alt-screen clips, so under-filling is safe). Scroll: mouse wheel (SGR mouse reporting enabled in `cli.tsx`; parsed off raw stdin in `App` since Ink doesn't model mouse — buttons 64/65) and PgUp/PgDn; new output re-pins to the bottom (`atBottomRef`); a scrollbar sits on the right. (Mouse reporting means text selection needs the terminal's modifier, e.g. Option-drag in Ghostty.) This replaced an earlier flex/overflow fullscreen that corrupted on tall output. Chrome spans full width; prose wraps ≤100 cols. The plain `Transcript` component is the inline-fallback renderer. `scripts/gen-mascot.ts` still bakes the PNGs + baked sprites (`mascot-sprite.ts` `GHOSTS`) — but those now feed **only the opt-in kitty/iTerm image path** (`image.ts`); the default blocks path renders the parametric engine instead. The splash scales to the terminal (big=2×/mini=1×/none by rows×cols, in `App.tsx`). The inline/working presence is the compact **state ghost** (see below) — a native-resolution head crop so Boo never dominates the transcript.

Commands: /help /model [name] (fuzzy — type "haiku") /plan /clear /retry /cwd /exit.

**Permission gate:** `write_file`/`edit_file`/`run_shell` block on a confirm before mutating. Broker: `src/permission.ts` (`requestPermission` in the tools; `setPermissionHandler` installed by `App`; no handler → allow, so tests/headless are unchanged). Decisions: **once** (1), **always** (2, grants that kind for the session), **all/yolo** (a, auto-approves everything until toggled), **deny** (3/esc). YOLO is also toggled by `/yolo` or started with `--yolo`; a `⚡ yolo` badge shows in the status. The `!` prefix is user-initiated so it is NOT gated. Search/nav tools: `search` (ripgrep, Bun-walk fallback) and `glob` (`Bun.Glob`), both read-only (also in plan mode). The working indicator IS Boo now (`components/Working.tsx`): a compact head-crop ghost whose face follows the agent state — thinking (dots) → streaming (talk) → tool (loading dots) → a clean-finish celebrate (party hat + confetti) → error (crying with falling tears). `App.tsx` derives `mascotState` from the `onEvent` stream; the success/error beat **lingers ~1.5s** after the turn (`linger` state — the working line gates on `busy || linger`, since it would otherwise unmount the instant `busy` goes false). Crops are per-state (`stateView`): head (rows 4–14), head+dots (2–14), head+hat (0–14) so overlays outside the head still read. This deliberately supersedes the earlier "Boo stays on the welcome splash only / in-flow movement reads as noise" decision — the compact, state-bearing ghost is the point of the design port.

## Conventions

- Runtime: **Bun**. TypeScript + TSX. Run with `bun run src/cli.tsx`.
- UI: **Ink** (React for terminals) + **@inkjs/ui**. Keep it calm and beautiful: restrained palette (one accent), generous spacing, consistent glyphs. The look lives in `src/ui/theme.ts` — change colors/glyphs there, not inline.
- Open + free: MIT, no paid dependencies, no hosted backend, no telemetry. The only cost is the user's own model calls on their own keys.
- Tools must be safe by default: confirm or sandbox anything destructive; never `rm -rf` or write outside the workspace without intent.

## Run it

```bash
bun install
# set at least one key:
export ANTHROPIC_API_KEY=...    # or OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY / DEEPSEEK_API_KEY
bun run src/cli.tsx             # or: bun start
```

With no key it launches in demo mode (a scripted transcript) so the UI still runs.

## Test

```bash
bun test            # render tests + agent-loop tests; no API key needed
bun run typecheck   # tsc --noEmit
```
