# Gearbox — project guide

Gearbox is a multi-provider coding harness for the terminal: a beautiful, simple terminal agent that reads/writes code and runs commands, talking to any provider (Anthropic, OpenAI, Google, DeepSeek) through one clean loop.

**The point of the project:** intelligent per-task *model routing* — automatically picking the right model for each task across every provider and account you pay for. Basic routing is live (`RoutingSelector` — classify → quality bar → cheapest winner); the richer engine (shadow-eval, credit/limit penalties, confidence display) layers on top of the same seam. See `DESIGN.md` for the full vision and `experiments/FINDINGS.md` for the validation behind it.

## The one rule that matters

**Keep the routing seam clean.** The agent must never hardcode a model. It asks a `ModelSelector` for the model to use. `RoutingSelector` is the live default (classify task → filter by quality bar → cheapest winner); `FixedSelector` is used only when a model is explicitly pinned (`--model` flag or `/model <name>`). Concretely:

- `src/model/selector.ts` — the seam. `select(task) => ModelChoice` (now carrying an optional `Backend` so the runner can dispatch in-loop vs a subscription seat). Do not bypass it.
- `src/model/router.ts` — `RoutingSelector` is **account-aware**: it scores `(model, account)` PAIRS, not just models. Candidates = in-loop registry models × the accounts that serve them + flat-rate subscription **seats** (`providers.subscriptionSeats()`, a seat mirrors a canonical model but runs via the vendor binary). Flow: classify → quality bar → context fit → global/`/prefer` preference filter → score → return `{model, reason, backend}`. A seat is ~free until its rate limit, so it wins by default and fails over to metered API as the window fills. `SubscriptionPinSelector`/`FixedSelector` are hard pins (explicit `/account use` or `/model`) that beat auto-routing.
- `src/model/scoring.ts` — the PURE scorer: `score = costEst + scarcity + switchPenalty + limitPenalty + apiThrottlePenalty − planBonus`, argmin tie-broken deterministically. No I/O; fixture-tested. Every account-state term degrades safely — and where a provider exposes nothing, we ESTIMATE rather than go blind: live API rate-limit headers (`src/model/rate-headers.ts`, parsed from each response → `apiThrottle`, gentle near-empty penalty) and a self-declared budget − tracked spend (`/budget`, an estimated balance feeding scarcity). A missing signal with no estimate is still neutral (no errors per provider).
- `src/model/routing-context.ts` — `buildRoutingContext()`: the per-turn account-state snapshot (balance where exposed, subscription rate headroom = min over the 5h/weekly windows) read from disk-cached `usage.json`. No network on the hot path; balances refreshed in the background (App effect).
- `src/model/profiles.ts` — the data corpus: quality, cost, latency, tokenizer calibration, **and the per-model effort vocabulary** (`efforts`) per the provider research. Routing reads this; effort is clamped/omitted against the chosen model's set, never sent unsupported.
- `src/providers.ts` — maps a provider+model id to an AI SDK model instance. Already multi-provider. Adding a model is data, not code.
- Every model call captures token usage (`src/agent/run.ts`) so the cost engine has data. Do not drop usage.
- The UI consumes a normalized `AgentEvent` stream (`src/agent/events.ts`), never the AI SDK's raw types. This decouples the UI from the provider layer and from routing.

If you find yourself writing `anthropic('claude-...')` anywhere outside `providers.ts`, stop — route it through the selector.

## Layout

```
src/
  cli.tsx            entry point; renders the Ink app; picks RoutingSelector by default
  config.ts          minimal config (default model, provider from env)
  providers.ts       provider+model id -> AI SDK model  (multi-provider; contextWindow per model)
  commands.ts        slash-command metadata + pure helpers (fuzzy model match, /help, model list)
  tools.ts           read / write / edit / list / search / glob / run_shell  (AI SDK tools)
  model/
    selector.ts      THE ROUTING SEAM — ModelSelector + ModelChoice.backend + FixedSelector (pinned model)
    router.ts        RoutingSelector (account-aware): scores (model, account) pairs incl. subscription seats; SubscriptionPinSelector
    scoring.ts       PURE scorer: cost + scarcity + limit − plan bonus; deterministic, fixture-tested
    routing-context.ts per-turn account-state snapshot (balance + subscription rate headroom) from usage.json
    cooldown.ts      reactive-failover support: classify a failure + park an exhausted account so the router routes around it
    profiles.ts      model corpus: quality (SWE-bench), cost ($/Mtok), latency, tokenizer calibration, per-model effort vocab
    tokens.ts        calibrated token counting (js-tiktoken × per-model calibration factor)
    preferences.ts   persist /prefer kind model choices to ~/.gearbox/routing-preferences.json
    reasoning.ts     reasoning/thinking config helpers
  context/
    builder.ts       context engine: system + memory + repo map + retrieved files + curated history
    retrieve.ts      BM25 lexical retrieval — top-K relevant files for a prompt (no model call)
    repomap.ts       repo structure summary for the system prompt
    memory.ts        project memory (GEARBOX.md / CLAUDE.md loaded into context)
    compact.ts       context compaction (/compact)
  accounts/
    types.ts         Account + AuthMethod types (API key, AWS, Azure, Vertex, CLI, OpenAI-compat)
    store.ts         accounts.json persistence (~/.gearbox/accounts.json)
    catalog.ts       provider catalog (known providers, env vars, labels)
    detect.ts        auto-detect env creds + cloud credentials
    onboard.ts       interactive add/test account flows; addByPastedKey routes through sniff.ts
    sniff.ts         pure credential sniffer: paste anything (key / AWS block / SA JSON / Azure URL / gateway key) → {kind, provider, fields, missing}
    resolve.ts       credential resolution (Account → ResolvedCreds) + rank(model) → ordered failover pool (cross-provider, health-sorted)
    discover.ts      per-account model discovery (Azure deployments / Foundry / gateway /models) → account.models; catalog defaultModels are seeds, not callable ids
    health.ts        account health: classifyError (provider error → state), checkHealth (cached probe, timeout-bounded), recordHealth; no background polling
    usage.ts         per-account spend ledger + rate-limit snapshots + balance tracking
    balance.ts       provider balance fetch helpers
  help/
    ask.ts           /ask corpus: bundled docs + generated command reference, system prompt, meta-question auto-detect
  agent/
    events.ts        AgentEvent — normalized stream the UI consumes
    run.ts           real agent loop (AI SDK streamText -> AgentEvent), abort-aware; runCompletion = tool-less grounded answer (used by /ask); returns a structured failure (for failover)
    failover.ts      runWithFailover: run a turn over the ranked account pool; on a credential failure before output, advance to the next; clear exhaustion errors
    cli-backend.ts   claude/codex CLI subprocess backend (for Pro/Max subscriptions)
    mock.ts          scripted demo stream (runs with no API key; used by tests)
  ui/
    theme.ts         colors + glyphs (the look)
    input.ts         pure key→action reducer for the composer (tested)
    history.ts       pure ↑/↓ prompt-history nav (tested)
    net.ts           background online probe; status bar shows ⚠ offline when down
    useTerminalSize.ts  reactive width on resize (everything reflows)
    git.ts           current branch for the status line
    App.tsx          the Ink app: state, useInput dispatch, commands, turns
    components/      Banner, Transcript, Composer, CommandPalette, StatusBar, PermissionPrompt, Panel
    panel.ts         dismissable command-panel model + pure helpers (clamp/window/filter); tested
test/                pure-logic + render tests (ink-testing-library); no keys
DESIGN.md            full product vision (routing, requirements, UX)
experiments/         prototypes that validated the architecture
```

The composer is custom (Ink `useInput` + `src/ui/input.ts`), not a third-party widget — full control over the cursor, ↑/↓ history, and esc-to-interrupt, with no focus/remount fragility. **Multi-line**: ⌃J (or shift/alt+⏎) inserts a newline, ⏎ submits; ↑/↓ move between lines and fall through to history at the top/bottom line; bracketed paste (enabled in `cli.tsx`) inserts multi-line text literally (CR normalized, paste markers stripped) instead of submitting per line. `caretPos()` is the shared line/col helper. **Readline editing** (all pure in `input.ts`, tested): ⌃U/⌃K kill to line start/end, ⌃W / ⌥⌫ kill word, ⌃D forward-delete, ⌥/⌃ + ←→ word-jump, ⌃A/⌃E line home/end. Keys: ⏎ send · ⌃J newline · ↑↓ line/history · ← → cursor · ⌥←→ word · tab complete @file · **shift+tab cycles mode (normal · auto-accept · plan)** · ⌃Y copy last reply · esc interrupt · ⌃c quit. `/keys` shows the cheatsheet.

**Modes & effort.** Three input modes cycled by shift+tab (`App.tsx` `cycleMode`): **normal** (asks before writes/edits/shell), **auto-accept** (file writes/edits apply without asking — the permission broker auto-resolves `write`/`edit`; shell still gated; diffs still render), **plan** (read-only). Plus **yolo** (auto-approve everything) via `/yolo`. **Effort tiers** (`/effort fast|balanced|max`, or `setEffort`) pin the model through the routing seam (fast→haiku, balanced/max→sonnet) — the active mode + `⚡effort` show as badges in the `StatusBar`. **Click pickers** (fullscreen only): clicking the **model** or **effort** label in the status bar opens a floating picker above it (↑↓ select · ⏎ apply · esc close), reusing the same `/model`/`/effort` command path. The slash commands remain the keyboard path. The fragile row+column hit-test lives in pure, tested `statusBarHit`/`statusBarLayout` (`StatusBar.tsx`); `App.tsx` only supplies live layout (composer line count, `PALETTE_ROWS`, the rendered model/effort/mode) and toggles `quickPicker` state. Inline mode has no mouse grab, so the labels stay informational there. **Copy**: ⌃Y / `/copy` copies the last reply via OSC 52 (`src/ui/clipboard.ts`, works over SSH); `/export [file]` writes the transcript to Markdown. **Terminal integration** (`src/ui/terminal.ts`): the tab title (OSC 2) reflects working/idle, and a long turn (>8s) rings the bell + fires a desktop notification (macOS) so you can step away.

**More UX affordances.** **Type-ahead**: prompts submitted while busy are queued (`queueRef`, shown as chips) and sent when the turn ends. **⌃C** interrupts a turn → clears the composer → "press again to quit" (`cli.tsx` renders with `exitOnCtrlC:false`). **Large pastes** collapse to a `[Pasted N lines]` chip (`pasteStoreRef`), expanded back on submit. **Fuzzy** `@file`/`/command` pickers (`src/ui/fuzzy.ts` — substring-first, then subsequence scored by boundary+contiguity; tested). **Cost**: live `$` estimate in the status bar from per-turn model+tokens (`estimateCost` + per-model pricing in `providers.ts`). **Syntax highlighting** for code blocks (`src/ui/highlight.ts` — lightweight per-line tokenizer → Ink spans, NEVER raw ANSI; used by both `lines.ts` `clipSpans` and `Markdown.tsx`). `?` on an empty composer shows the cheatsheet (`KEYS_HELP`).

**Sessions** (`src/session.ts`): conversations persist per-project under `~/.gearbox/sessions/<slug>/` (`GEARBOX_HOME` overrides). Each record holds provider-neutral `messages` + the UI `items` + **per-turn `{model, usage, at}`** (routing/cost data — the record is deliberately not single-model). `gearbox --continue`/`-c` resumes the latest; `/resume [n]` lists/loads in-app; `/clear` starts a fresh session. Prompt history persists across runs (`history.json`). Saving is best-effort (never crashes the app); skipped in demo mode.

Features: full markdown via **marked** (parse, `marked.lexer`) + **Ink** (render) in `Markdown.tsx` — headings, bold/italic/inline-code, tables, ordered+nested lists, blockquotes, code blocks. NO foreign ANSI in Ink (cli-highlight/marked-terminal were tried and removed — they corrupt Ink's width/wrapping; render marked's token tree as Ink elements instead). Markdown gets a `width` prop (threaded App→Transcript→Markdown) for table/rule sizing. Colored diffs under edits (`src/diff.ts`, edit/write tools return `{summary,diff}`), plan mode (read-only tools + plan prompt; `/plan` or shift+tab), `!cmd` runs a shell command directly (`src/shell.ts`), `@file` mentions (fuzzy picker `src/ui/mention.ts`+`files.ts`; expanded into the model message on send), live "working · Ns" timer.

**Boo (the mascot).** A pixel ghost, now **parametric** (`src/ui/ghost/engine.ts`, ported from a Claude Design handoff). A 20×20 pixel sprite composited from composable layers — body (palette) + face (eyes/mouth) + accessory + persona + a frame-driven overlay (tears/dots/confetti/Z's/sparkle/hearts) — then FOLDED into half-block cells (`▀`/`▄`, top px → `t`/glyph color, bottom px → `b`/bg). `renderGhost(cfg)` is the source of truth for the **default blocks path**; it's pure + memoized. The data: 13 faces (`FACES`), 9 palettes (`PALETTES`), 6 accessories, 9 personas (personas/accessories ported but not yet surfaced in the live UI). Ink `color`/`backgroundColor` props only, NEVER raw ANSI (corrupts Ink's width math). PNG paths are **opt-in** via `GEARBOX_GHOST`:

- `GEARBOX_GHOST=kitty` — real PNG via kitty graphics Unicode placeholders (`U+10EEEE`, fg encodes image id, diacritics encode row/col; PNGs transmitted once in `cli.tsx`). NOTE: the placeholder protocol is young and mis-rendered (squished) in Ghostty during testing — kept opt-in until that's solved.
- `GEARBOX_GHOST=iterm` — OSC 1337 splash banner (iTerm2/WezTerm).

`detectImageMode()` returns `blocks` unless `GEARBOX_GHOST` opts in. Baked PNGs live in `src/ui/mascot-png.ts`; `bun run scripts/ghost-preview.ts` previews the parametric engine (splash + all faces + the in-flow state crops). **Boo is animated but deliberately calm** on the blocks path (`AnimatedGhost` in `Mascot.tsx`): one shared, unhurried 240ms tick (leaf-local `useTick`, never lifted to App root); talk + overlays advance at half that (~480ms). There is NO idle bob/float and NO splash sparkle — motion is a quiet sign of life, not fidgeting (the splash just blinks every ~6s; in-flow only the state-meaningful overlay/talk moves). `GEARBOX_NO_MOTION=1` freezes to frame 0. `/ghost [mood]` cycles the skin (`skinToCfg` maps it to a cfg; `shades` is the cool face + shades accessory).

**Layout: fullscreen by default; inline is opt-in.** **Fullscreen is the default** (alt-screen frame + virtualized scroll region + scrollbar + mouse wheel scroll); `--inline`, `GEARBOX_INLINE=1`, or `/config inline on` (pref `fullscreen: false`) opts into inline mode. `GEARBOX_FULLSCREEN=1` or `--fullscreen` forces fullscreen explicitly. The decision lives in `cli.tsx` (`wantsFullscreen`). Grabbing the mouse for wheel-scroll is exactly what disables native terminal selection, so in fullscreen mode text selection requires the terminal's modifier (e.g. Option-drag in Ghostty). **Inline mode** (the plain `Transcript` component): no alt-screen, no mouse grab — native click-drag selection / scrollback / copy all work with no modifier. The transcript is a **virtualized line buffer**: `src/ui/lines.ts` (`itemsToLines`) flattens items into styled `Line`s (markdown→lines, wrapping, diffs) — INVARIANT: every line ≤ width (tested), so nothing overflows. **Streaming perf**: flattening the markdown-heavy `assistant`/`user` items is super-linear with their length, so `staticItemLines` memoizes per item in a `WeakMap` keyed by object reference (unchanged items keep identity across renders, so only the changing tail re-parses — history is free; running tools are not cached since their spinner animates). On the producer side, assistant **text deltas are coalesced** on a ~45ms flush timer in `App.tsx`'s `onEvent` (mirroring the tool-stream coalescer), so streaming re-renders at ~22fps instead of per-token — both together stop the auto-scroll jitter that grew with reply length. `finishAssistant`/the turn `finally` flush any buffered text before marking done or on interrupt. In fullscreen, `App` renders only the visible window via `Viewport` (`src/ui/components/Viewport.tsx`) at a computed `transcriptHeight = rows − header − footer` (footer over-estimated so the frame never exceeds the screen; alt-screen clips, so under-filling is safe). Fullscreen scroll: mouse wheel (SGR mouse reporting enabled in `cli.tsx`; parsed off raw stdin in `App` since Ink doesn't model mouse — buttons 64/65) and PgUp/PgDn; new output re-pins to the bottom (`atBottomRef`); a scrollbar sits on the right. (In fullscreen, mouse reporting means text selection needs the terminal's modifier, e.g. Option-drag in Ghostty — which is why inline is now the default.) The virtualized buffer replaced an earlier flex/overflow fullscreen that corrupted on tall output. Chrome spans full width; prose wraps ≤100 cols. The plain `Transcript` component is the inline-fallback renderer. `scripts/gen-mascot.ts` still bakes the PNGs + baked sprites (`mascot-sprite.ts` `GHOSTS`) — but those now feed **only the opt-in kitty/iTerm image path** (`image.ts`); the default blocks path renders the parametric engine instead. The splash scales to the terminal (big=2×/mini=1×/none by rows×cols, in `App.tsx`). The inline/working presence is the compact **state ghost** (see below) — a native-resolution head crop so Boo never dominates the transcript.

Commands are grouped in `/help` (models · conversation · accounts · save · modes · settings · other) and `src/commands.ts` carries plain-language descriptions: /model [name] (fuzzy — "haiku"; `/model auto` routes, `/model all` lists every provider) /effort [fast|balanced|max] /prefer [kind model] (remember a confirmed routing preference for a task type) /clear /resume /retry /compact /context /memory /ask &lt;q&gt; (answer questions about Gearbox itself from its bundled docs via a cheap routed model; plain meta-questions auto-route here with a visible affordance) /account (unified: list/add/login/use/rm/refresh — `/accounts` and `/login` are hidden aliases; `/account refresh` re-discovers each account's real callable models) /cost (fullscreen: TOGGLES a persistent usage strip above the composer — context % · subscription 5h/7d headroom · session spend — stays until toggled off, persisted via `prefs.statusPinned`, doesn't capture input; `StatusStrip.tsx`. inline: one-shot card) /copy /export [file] /plan /yolo /theme /config (theme·vim·notify·inline; `/vim` is a hidden alias) /init /keys /help /exit. **Hidden** (work but not listed): /accounts /login /vim /ghost. **Removed:** /cwd (the working dir now shows in `/context`). `formatModelList` shows usable models first and collapses no-key providers to a one-line count.

**Command panel (fullscreen only).** Big info-dump commands open a dismissable, Esc-closable overlay instead of dumping into the transcript (`Panel.tsx` + pure `panel.ts`, wired in `App.tsx`): `/help` `/keys` `/context` `/cost` `/memory` are scrollable static dumps (reuse `itemsToLines` + `Viewport`); `/account` and `/model` are interactive lists (↑↓ select · ⏎ acts — they just dispatch the equivalent `/account <n>` / `/model <id>` command and close), and `/model` has type-to-filter (127 Foundry models). The panel replaces the transcript Viewport region while open and takes precedence over `welcome`; the key handler is a branch in `useInput` placed after ⌃C so Esc closes the panel rather than interrupting a turn. Short confirmations (`model → haiku`, `remembered`, `✓ added`, errors) stay inline. Inline mode keeps the old inline printing (no alt-screen to overlay). `openInfoPanel` returns false inline so callers fall back to `push`.

**Accounts: reliability by design.** Every subscription, API key, and cloud credential is meant to work all the time. Switching is **by name only** (a stable unique `slug` per account, e.g. `claude-work`; positional numbers are gone — removing an account never repoints another). Each account carries a cached **health** state (`✓ ready · ⚠ expired · ✗ invalid · ⏳ limited · — unknown`) refreshed at natural touchpoints (boot sweep, opening `/account`, on switch, on live failure) — never by background polling; probes are timeout-bounded. A turn runs through a **failover pool**: `resolve.rank(model)` returns every account that can serve the model's family (cross-provider — Claude can fall Anthropic key → Bedrock → Vertex), health-sorted; `agent/failover.ts` tries them best-first and, on a credential-class failure **before any output** (expired/invalid/no-credit/rate-limited), transparently advances to the next and tells the user which account ran. A real (network/model) error or any failure after output streamed does NOT churn the pool. When the pool is exhausted, one consolidated error names each account, why it failed, and the one command to fix it. Expired subscriptions get one-step re-login: `/account login <name>` (and CLI failures name that exact command). `/account add <paste>` runs the credential **sniffer** (`accounts/sniff.ts`) — paste an API key, an AWS access key or credentials block, a Vertex service-account JSON, an Azure endpoint, or a Vercel gateway key, and it identifies the provider, fills the gaps interactively, and live-tests it.

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
