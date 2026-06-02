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

The composer is custom (Ink `useInput` + `src/ui/input.ts`), not a third-party widget — full control over the cursor, ↑/↓ history, and esc-to-interrupt, with no focus/remount fragility. Keys: ⏎ send · ↑↓ history · ← → / ⌃a / ⌃e cursor · tab complete @file · shift+tab toggle plan · esc interrupt (or clear) · ⌃c quit.

Features: full markdown via **marked** (parse, `marked.lexer`) + **Ink** (render) in `Markdown.tsx` — headings, bold/italic/inline-code, tables, ordered+nested lists, blockquotes, code blocks. NO foreign ANSI in Ink (cli-highlight/marked-terminal were tried and removed — they corrupt Ink's width/wrapping; render marked's token tree as Ink elements instead). Markdown gets a `width` prop (threaded App→Transcript→Markdown) for table/rule sizing. Colored diffs under edits (`src/diff.ts`, edit/write tools return `{summary,diff}`), plan mode (read-only tools + plan prompt; `/plan` or shift+tab), `!cmd` runs a shell command directly (`src/shell.ts`), `@file` mentions (fuzzy picker `src/ui/mention.ts`+`files.ts`; expanded into the model message on send), live "working · Ns" timer.

Commands: /help /model [name] (fuzzy — type "haiku") /plan /clear /retry /cwd /exit.

**Still unguarded (known gap):** `write_file`/`edit_file`/`run_shell` and the `!` prefix execute without a confirm/permission gate. That's the next table-stake (a minimal allow-once/always/deny confirm before mutating actions). Do not assume it's safe to point at an untrusted repo yet.

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
