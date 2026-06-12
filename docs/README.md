# Gearbox documentation

User-facing docs. The repo-root files (README, DESIGN, CLAUDE) are for
contributors and the /ask corpus; this directory is what a new user reads.

## Pages

- [getting-started.md](getting-started.md) — install, add an account, first turn
- [routing.md](routing.md) — how model routing works and how to steer it (/why, /prefer, /model)
- [accounts.md](accounts.md) — API keys, subscriptions, cloud creds, failover *(stub)*
- [safety.md](safety.md) — permissions, sandbox, undo/checkpoints, VERIFY *(stub)*
- [tabs.md](tabs.md) — parallel sessions, worktrees, /tab merge *(stub)*
- [cost.md](cost.md) — spend tracking, budgets, caps *(stub)*

## Conventions

One page per pillar; lead with the 90% use case; every flag and slash command
shown in a copyable block; no feature lists without the command that reaches
them. Pages here may later feed the /ask corpus via scripts/gen-docs.mjs
(add the path to its `files` list when a page stabilizes).
