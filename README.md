# ⚙ gearbox

A beautiful, simple coding harness for the terminal. It reads, edits, and runs your code through one clean agent loop, talking to any provider (Anthropic, OpenAI, Google, DeepSeek).

> **What it does:** the point of Gearbox is *intelligent per-task model routing* — automatically using the right model for each task across every provider and account you pay for, cheaply and transparently. Basic routing is live: it classifies each task, filters candidates by quality bar, and picks the cheapest one that fits. The richer engine (shadow-eval, credit/limit scoring, confidence display) layers on top. See [`DESIGN.md`](./DESIGN.md).

```
 ⚙   gearbox
     coding harness · sonnet-4.6
 ──────────────────────────────────────────────────────────

 › add a --json flag to the CLI and cover it with a test

 ⏺  I'll see how args are parsed, add the flag, then test it.

   ✓ read_file  src/cli.tsx
     renders the Ink app · 18 lines
   ✓ edit_file  src/cli.tsx
   ✓ run_shell  bun test
     9 pass · 0 fail

 ⏺  Done — flag added with a passing test.

 ╭──────────────────────────────────────────────────────────╮
 │ › ask gearbox to build or fix something                  │
 ╰──────────────────────────────────────────────────────────╯
  gearbox · sonnet-4.6 · 18,432 tok · ⏎ send  ctrl+c quit
```

## Run

```bash
bun install
gearbox auth add <api-key>     # paste-detects common providers when possible
# or: gearbox auth add <provider> <api-key>
# or: gearbox auth import      # import keys from env/cloud credentials
bun start                      # or: bun run src/cli.tsx
bun start -- --model gemini-flash   # pick a model
```

No provider configured? Gearbox opens a setup screen and will not run a fake model. Preview the look without running anything:

```bash
bun run scripts/preview.tsx
```

## Install

One command, no sudo, no npm global permissions:

```bash
curl -fsSL https://raw.githubusercontent.com/AnayGarodia/gearbox/main/install.sh | bash
```

The installer downloads the published `gearbox-code` package and creates a
user-owned `gearbox` command in `~/.local/bin`.

Then:

```bash
gearbox auth add <api-key>     # each person uses their own provider account
cd ~/any/project && gearbox    # the current directory is the workspace
```

If `~/.local/bin` is not on your PATH, the installer prints the exact line to
add to your shell config.

You can still run without installing:

```bash
npx gearbox-code@latest
```

**Upgrade** later by rerunning the install command. `gearbox upgrade` still works
for git checkouts.

## Develop From Source

Requires [Bun](https://bun.sh). Clone the repo, then:

```bash
bun install
bun run src/cli.tsx
```

**Standalone binary** (no clone/install on the target, same OS/arch):

```bash
bun run build         # → dist/gearbox  (single ~64MB executable)
cp dist/gearbox ~/.bun/bin/    # or anywhere on PATH; share the file directly
```

> ⚠ **Before running on real code:** there is no permission/confirm gate yet — `write_file`, `edit_file`, `run_shell`, and the `!` prefix execute without asking. Fine for trusted internal use on your own repos; do not point it at anything you don't want modified. A confirm-gate is the next thing to land.

## Develop

```bash
bun test            # render + agent tests (no API key needed)
bun run typecheck
```

## Principles

- **Open + free.** MIT. No paid dependencies, no hosted backend, no telemetry. The only cost is your own model calls on your own keys.
- **Beautiful + calm.** One accent color, generous spacing, consistent glyphs. The whole look lives in `src/ui/theme.ts`.
- **Routing-ready.** Model choice happens in exactly one place (`src/model/selector.ts`); the router drops in there later with no changes upstream. See [`CLAUDE.md`](./CLAUDE.md).

## Status

v0.1 — streaming agent loop, real file + shell tools, a polished Ink TUI, multi-provider support, accounts + spend ledger, BM25 context retrieval, and basic per-task routing (classify → quality bar → cheapest winner). The richer routing engine (shadow-eval, credit/limit/plan scoring, per-repo calibration) is next (`DESIGN.md`).
