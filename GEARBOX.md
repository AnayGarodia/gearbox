# Gearbox

A multi-provider terminal coding agent. v0.1 is the harness — a clean agent loop
with streaming, tools, sessions, and a rich TUI. The headline feature landing on
top is **intelligent model routing**: automatically picking the cheapest model
that clears the quality bar for each task, across every provider and key you pay
for. See `DESIGN.md` for the full vision.

---

## Build, test, run

**Requires:** [Bun](https://bun.sh) ≥ 1.1, at least one provider API key.

```sh
bun install            # install deps
bun test               # 69 tests, ~2s, no keys needed
bun run typecheck      # tsc --noEmit
bun run src/cli.tsx    # run from source (dev)
bun run build          # compile to dist/gearbox (single binary)
```

**Keys** (set any one or more):
```sh
export ANTHROPIC_API_KEY=...
export OPENAI_API_KEY=...
export GOOGLE_GENERATIVE_AI_API_KEY=...
export DEEPSEEK_API_KEY=...
```

No key → demo mode (scripted mock, no API calls).

**Common invocations:**
```sh
gearbox                          # start in cwd
gearbox --model haiku            # specific model (fuzzy match)
gearbox --continue / -c          # resume latest session
gearbox --yolo                   # skip permission prompts
```

---

## Layout

```
src/
  cli.tsx              entry point; arg parsing, Ink render, alternate screen
  config.ts            Config (defaultModelId, maxSteps); GEARBOX_MODEL / GEARBOX_MAX_STEPS envs
  providers.ts         ProviderId, ModelSpec, MODELS registry, resolveModel()
                         ← ONLY place that touches a concrete provider SDK
  model/
    selector.ts        THE ROUTING SEAM — select(task) → ModelChoice
                         FixedSelector today; smart router drops in here later
  commands.ts          Slash-command metadata, /help, model list/switch, context breakdown
  tools.ts             AI SDK tools: read_file, write_file, edit_file, search, glob,
                         list_dir, run_shell (scoped to cwd; permission-gated)
  permission.ts        Permission broker — write/edit/shell ask before running
                         (auto-approved under --yolo or "allow all")
  shell.ts             runShell() — execSync wrapper, output capped at 60k chars
  diff.ts              computeDiff / diffStat — unified diff for write/edit results
  session.ts           Session persistence (~/.gearbox/sessions/<slug>/); per-turn
                         model+usage stored for the future cost engine
  context/
    builder.ts         Context Engine: curates history + injects memory/repomap/
                         retrieved files into a bounded system prompt per turn
    memory.ts          Two-layer memory: GEARBOX.md (project brief) + facts.md
                         (living notes via /memory or #note)
    repomap.ts         Lightweight repo map injected into every system prompt
    retrieve.ts        File retrieval: surfaces relevant files for each turn
  agent/
    events.ts          AgentEvent — the normalized stream the UI consumes
                         (never expose raw AI SDK types above this layer)
    run.ts             Real agent loop: streamText → AgentEvent, abort-aware,
                         incremental tool-input streaming, usage capture
    mock.ts            Scripted demo stream (no key needed; used by tests)
  ui/
    App.tsx            Root Ink component: state, useInput, slash commands, turns
    theme.ts           Colors + glyphs (the look)
    input.ts           Pure key→action reducer for the composer (tested)
    history.ts         Pure ↑/↓ prompt-history nav (tested)
    lines.ts           itemsToLines — flattens transcript items to fixed-width
                         Line[]; INVARIANT: every line ≤ width (tested)
    git.ts             Current branch for the status bar
    mention.ts / files.ts  @file fuzzy picker
    useTerminalSize.ts Reactive terminal width
    image.ts           Ghost rendering mode detection (blocks/kitty/iterm)
    components/        Banner, Transcript, Viewport, Composer, CommandPalette,
                         FilePalette, Markdown, Mascot, StatusBar,
                         PermissionPrompt, Working
    ghost/engine.ts    Parametric pixel-ghost renderer (Boo the mascot)
test/                  Pure-logic + Ink render tests; no API keys required
experiments/           Architecture validation prototypes (findings in FINDINGS.md)
```

---

## Architecture invariants

### The routing seam
`src/model/selector.ts` is the single point of model choice. **Never** call a
provider SDK directly outside `providers.ts` or hardcode a model id anywhere.
The agent asks the selector; the selector returns a `ModelChoice`.

```
FixedSelector.select(task)          ← today: first available model
    └─ pickDefaultModel()           ← src/config.ts
         └─ resolveModel(spec)      ← src/providers.ts (only SDK touch)
              └─ streamText(...)    ← src/agent/run.ts
```

### The event boundary
`src/agent/run.ts` emits `AgentEvent` (`src/agent/events.ts`). The UI consumes
only `AgentEvent` — never the raw AI SDK stream types. This decouples the UI
from both the provider and the routing layer.

### The context engine
`src/context/builder.ts` assembles the system prompt and curates history before
every turn. It injects: base system + plan addendum + project memory
(`GEARBOX.md`/`CLAUDE.md`/`AGENTS.md` + `facts.md`) + a repo map + retrieved
files. History is curation-trimmed at whole-turn boundaries (never splitting a
`tool_use` from its `tool_result`) to stay within the model's context window.

### Usage is always captured
Every model call captures `{ inputTokens, outputTokens }` in `run.ts` and
stores it in `session.turns`. Do not drop usage — it feeds the future cost engine.

### No raw ANSI in Ink
Use `color`/`backgroundColor` props only. Raw ANSI escape sequences corrupt
Ink's width math and break the virtualized line buffer.

---

## Key conventions

| Convention | Detail |
|---|---|
| Adding a model | Add a row to `MODELS` in `providers.ts` — data, not code |
| Adding a slash command | Add to `COMMANDS` in `commands.ts`, handle in `App.tsx` |
| Permission gates | Mutating tools call `requestPermission()` before acting |
| Session data dir | `~/.gearbox/` (override: `GEARBOX_HOME`) |
| Max agent steps | `GEARBOX_MAX_STEPS` env (default 24) |
| Demo / CI mode | No key → `runTaskMock()` in `agent/mock.ts` |
| Fullscreen | `GEARBOX_INLINE=1` forces plain inline flow |
| Ghost rendering | `GEARBOX_GHOST=kitty\|iterm` opts in to PNG paths |
| Motion freeze | `GEARBOX_NO_MOTION=1` freezes Boo to frame 0 |

### In-app keys
`⏎` send · `⌃J` newline · `↑↓` line/history · `tab` @file complete ·
`shift+tab` plan mode · `esc` interrupt · `⌃c` quit

### Slash commands
`/help` `/model` `/plan` `/init` `/memory` `/context` `/ghost` `/yolo`
`/clear` `/resume` `/retry` `/cwd` `/exit`

---

## Data flow (one turn)

```
User ⏎
  → App.tsx: buildContext() assembles system + messages
  → selector.select(task) → ModelChoice
  → runTask({ model, messages, system, onEvent })
      → streamText (AI SDK) → fullStream
          → AgentEvent stream → App state → Viewport render
  → session saved (~/.gearbox/sessions/<slug>/<id>.json)
```

---

## Tests

All tests are in `test/`; run with `bun test`. Tests cover: agent mock stream,
commands, context engine, diff, prompt history, image mode, input reducer, line
buffer, mascot renderer, mention picker, permission broker, session persistence,
tool-input streaming. No API keys required; the real agent loop is exercised via
`runTaskMock`.
