# Gearbox

A multi-provider terminal coding agent. The harness is a clean agent loop with
streaming, tools, sessions, and a rich TUI; the headline feature — **intelligent
model routing** — is live: every turn is classified, scored against every
(model, account) pair you pay for (API keys, cloud creds, and flat-rate
subscription seats), and sent to the cheapest candidate that clears the quality
bar. Per-repo measured priors (the flywheel) adjust those scores from real
VERIFY outcomes. See `DESIGN.md` for the vision, `ROADMAP.md` for status,
`CLAUDE.md`/`AGENTS.md` for the deep contributor guide.

---

## Build, test, run

**Requires:** [Bun](https://bun.sh) ≥ 1.1, at least one provider account.

```sh
bun install            # install deps
bun test               # full suite, no keys needed
bun run typecheck      # tsc --noEmit
bun run src/cli.tsx    # run from source (dev only — use the installed `gearbox` binary for real work)
bun run build          # compile to dist/gearbox (single binary)
```

**Provider setup** (any of ~25 catalog providers):
```sh
gearbox auth add <api-key>             # sniffer auto-detects the provider
gearbox auth add <provider> <api-key>
gearbox auth add claude work           # subscription seat via the vendor CLI
gearbox auth import                    # pick up env/cloud credentials
```

No account configured → interactive onboarding. Gearbox does not run a fake model.

**Common invocations:**
```sh
gearbox                          # start in cwd (fullscreen UI)
gearbox --model haiku            # pin a model (fuzzy match; disables routing)
gearbox --continue / -c          # resume latest session
gearbox --yolo                   # skip permission prompts
gearbox --inline                 # plain terminal scrollback instead of alt-screen
gearbox -p "prompt" [--json]     # headless one-shot
```

---

## Layout (orientation — see CLAUDE.md for the annotated tree)

```
src/
  cli.tsx              entry point; arg parsing, headless subcommands, Ink render
  providers.ts         provider+model id → AI SDK model (the ONLY SDK touchpoint)
  tools.ts             AI SDK tools: read/write/edit/list/search/glob/run_shell/
                         fetch_url/web_search/remember (+ MCP + delegate merged in)
  mcp.ts               MCP client: mcp.json configs → mcp_<server>_<tool> tools
  verify.ts            VERIFY gate: detect checks, run post-edit, iterate to green
  undo.ts / git/ops.ts per-turn snapshots + whole-tree checkpoints → /undo, /diff, git suite
  model/
    selector.ts        THE ROUTING SEAM — select(task) → ModelChoice (+ backend)
    router.ts          RoutingSelector: scores (model, account) pairs incl. subscription seats
    scoring.ts         pure scorer: cost + scarcity + penalties − plan bonus
    priors.ts          per-repo measured priors from VERIFY outcomes (the flywheel)
    profiles.ts        model corpus: quality, cost, latency, effort vocab
  accounts/            multi-account system: store, sniffer, resolve/failover rank,
                         health, usage, ledger (the single spend writer)
  context/             context engine: builder, BM25 retrieval, repo map, memory, compaction
  agent/
    events.ts          AgentEvent — the normalized stream the UI consumes
    run.ts             agent loop: streamText → AgentEvent; usage always captured
    classify.ts        cheap task classifier feeding the router
    delegate.ts        delegate / delegate_parallel sub-agents (worktree-isolated)
    cli-backend.ts     claude/codex CLI subprocess backend (subscription seats)
  ui/
    App.tsx            root Ink component: state, turns, the live failover hop-loop
    command-handler.ts ALL slash-command dispatch — new commands go here
    lines.ts           virtualized line buffer; INVARIANT: every line ≤ width
    components/        Composer, Viewport, Transcript, Panel, StatusBar, Mascot, …
test/                  pure-logic + Ink render tests; no API keys required
```

---

## Architecture invariants

### The routing seam
`src/model/selector.ts` is the single point of model choice. **Never** call a
provider SDK outside `providers.ts` or hardcode a model id. `RoutingSelector`
is the live default (classify → quality bar → cheapest winner across accounts
and subscription seats); `FixedSelector` exists only for an explicit pin
(`--model`, `/model <name>`).

### The event boundary
`src/agent/run.ts` emits `AgentEvent` (`src/agent/events.ts`). The UI consumes
only `AgentEvent` — never raw AI SDK stream types.

### Spend truth
Every dollar flows through `accounts/ledger.ts recordSpend()` — usage.json
aggregates + append-only `~/.gearbox/ledger.jsonl` + the session's per-turn
record, all from one event. Never drop usage capture; never write spend
anywhere else.

### VERIFY
A turn that edited files runs the detected checks (`src/verify.ts`) and reports
the proof tier honestly (tests > types > unverified), auto-iterating to green
(≤3). Outcomes feed the per-repo priors.

### No raw ANSI in Ink
Use `color`/`backgroundColor` props only. Raw escape sequences corrupt Ink's
width math and the virtualized line buffer.

---

## Key conventions

| Convention | Detail |
|---|---|
| Adding a model | Data, not code: `providers.ts` registry + `model/profiles.ts` corpus row |
| Adding a slash command | Metadata in `commands.ts`, dispatch in `ui/command-handler.ts` (not App.tsx) |
| Permission gates | Mutating tools call `requestPermission()`; project rules in `.gearbox/permissions.json` |
| Data dir | `~/.gearbox/` (override: `GEARBOX_HOME`) |
| Layout | Fullscreen by default; `--inline` / `GEARBOX_INLINE=1` opts into inline |
| Ghost rendering | `GEARBOX_GHOST=kitty\|iterm` opts into PNG paths; `GEARBOX_NO_MOTION=1` freezes |
| Crash safety | usage.json + sessions written via temp-write + rename |

### In-app keys
`⏎` send · `⌃J` newline · `↑↓` line/history · `tab` @file complete ·
`shift+tab` cycle mode (normal · auto-accept · plan) · `⌃Y` copy reply ·
`esc` interrupt · `⌃c` quit · `/keys` for the full cheatsheet

### Slash commands (grouped in /help)
Routing: `/model` `/effort` `/prefer` `/why` · Conversation: `/clear` `/resume`
`/retry` `/undo` `/diff` `/compact` `/context` `/memory` `/ask` · Accounts:
`/account` `/onboard` `/mcp` `/usage` `/budget` `/cap` · Git: `/commit` `/push`
`/pr` `/worktree` `/checkpoint` · Modes/settings: `/plan` `/yolo` `/verify`
`/theme` `/config` · Save: `/copy` `/export` · Other: `/init` `/keys` `/help` `/exit`

---

## Data flow (one turn)

```
User ⏎
  → classify (cheap model / keyword fast-path) → task kind
  → buildContext() assembles system + memory + repo map + retrieved files
  → selector.select(task) → ModelChoice {model, account, backend, reason}
  → runTask (in-loop API) or CLI backend (subscription seat)
      → streamText → AgentEvent stream → App state → Viewport render
      → failure before output? classify → park cooldown → re-select → hop (≤2)
  → ledger.recordSpend() → usage.json + ledger.jsonl + session turn meta
  → VERIFY gate (if files changed) → priors updated
  → session saved (~/.gearbox/sessions/<slug>/)
```

---

## Tests

All tests live in `test/`; run `bun test` (no API keys — the agent loop is
exercised via mocked runners and event fixtures). Pure logic is tested directly
(scoring, input reducer, line buffer, panel state machines); UI via
ink-testing-library renders; the turn lifecycle via a headless App harness.
