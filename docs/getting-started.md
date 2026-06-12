# Getting started

Gearbox is a terminal coding agent that routes each task to the cheapest model
that clears a quality bar — across every provider and account you already pay
for — and verifies its work against your project's own tests.

## Install

```bash
# macOS / Linux
curl -fsSL https://unpkg.com/gearbox-code@latest/install.sh | bash

# Windows (PowerShell)
irm https://unpkg.com/gearbox-code@latest/install.ps1 | iex
```

(The package name on npm is `gearbox-code`; the installer needs no sudo and
no global npm install — it places a user-owned shim on your PATH.)

Run `gearbox` in a project directory. With no provider configured it walks you
through onboarding interactively.

## Add a way to pay for models

Any ONE of these is enough to start:

```bash
export ANTHROPIC_API_KEY=...          # or OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY / DEEPSEEK_API_KEY
```

or paste anything into the account wizard — an API key, an AWS credentials
block, a Vertex service-account JSON, an Azure endpoint:

```
/account add <paste>
```

Have a Claude Pro/Max or ChatGPT subscription? `/account login claude` (or
`codex`) attaches it as a flat-rate seat: routing treats it as ~free until its
rate window fills, then fails over to your metered keys automatically.

## First turn

Type what you want done. Gearbox classifies the task, picks a model (the
status bar shows which and why — click it or run `/why` for the full
scorecard), asks before writing files or running commands, and after edits
runs your project's typecheck/tests as proof.

The keys that matter on day one:

```
⏎ send · ⌃J newline · shift+tab cycle mode (normal/auto-accept/plan) · esc interrupt
/help    all commands         /model <name>   pin a model (/model auto to unpin)
/why     routing scorecard    /undo           revert the last turn's changes
/usage   spend + limits       /diff           everything this session changed
```

## If something feels wrong

- A model keeps failing here? It is being measured: `/why` shows
  `measured here: 3/7 ✓` and routing sinks it for this repo automatically.
- Want a different model for a task type? Confirm one good turn, then
  `/prefer <kind> <model>`.
- Need raw control? `/model <name>` pins; `/yolo` removes prompts; `/plan`
  makes everything read-only.
