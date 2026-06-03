# P0.5 spike — claude/codex stream-json schemas (for src/agent/cli-backend.ts)

Recorded 2026-06 on this machine (claude 2.1.161, codex 0.136.0). These are the
real event schemas the CLI-backed subprocess runner must map to our `AgentEvent`
stream (`src/agent/events.ts`). Confirms the headline subscription feature is
feasible; locks the mapping before P3.

## claude — `claude -p "<prompt>" --output-format stream-json --verbose`
NDJSON, one JSON object per line. Event `type`s seen / relevant:
- `system` `subtype:"init"` — `{session_id, model, tools[], permissionMode, cwd}`. Capture `session_id` for `--resume`.
- `system` `subtype:"hook_*"` — SessionStart hook noise (this machine's superpowers setup dumps a huge skill). **Filter out.** Also the cause of cost blow-up below.
- `assistant` — `{message:{content:[{type:"text",text} | {type:"tool_use",id,name,input}], usage:{input_tokens,output_tokens,cache_*}}}`. Map text → `{type:"text"}`; tool_use → `{type:"tool-start", id, name, arg}`.
- `user` — `{message:{content:[{type:"tool_result", tool_use_id, content}]}}`. Map → `{type:"tool-end", id:tool_use_id, ok, summary}`.
- `result` — FINAL. `{result:"<text>", usage:{input_tokens,output_tokens,...}, total_cost_usd, duration_ms, num_turns, stop_reason, session_id}`. Map → `{type:"done", usage:{inputTokens,outputTokens}}` and capture **`total_cost_usd`** (cost is reported! feeds ACCOUNT pillar).
- `rate_limit_event` — `{rate_limit_info:{status,resetsAt,rateLimitType,utilization,isUsingOverage}}`. Gold for limit-awareness (e.g. utilization 0.81 of `seven_day`). Capture for P4.

Granular text streaming: pass `--include-partial-messages` to get `stream_event`
deltas; without it, `assistant` text arrives per complete block (coarser, fine for v1).
Cost note: the bare spike cost ~$0.19 because the SessionStart hook injected ~23k
cache-creation tokens. For Gearbox's use, run with hooks/settings disabled
(e.g. `--settings '{}'` / a clean env) so a subscription turn isn't taxed by the
host's Claude Code config.

## codex — `codex exec --skip-git-repo-check --json "<prompt>"`
NDJSON. Needs `--skip-git-repo-check` outside a trusted git dir, and `</dev/null`
(it reads stdin otherwise). Events:
- `{type:"thread.started", thread_id}` — session id for resume (`codex exec resume`).
- `{type:"turn.started"}`.
- `{type:"item.completed", item:{id, type, ...}}` — `item.type:"agent_message"` `{text}` → `{type:"text"}`; `item.type:"command_execution"`/tool items → `tool-start`/`tool-end`; `item.type:"error"` `{message}` → `{type:"error"}` (also emits deprecation warnings here — treat non-fatal).
- `{type:"turn.completed", usage:{input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens}}` → `{type:"done", usage}`. **No cost field** (subscription).
- Stderr carries MCP/auth noise (e.g. an unrelated GitHub Copilot MCP auth error). Read stdout only; log stderr at debug.

## Mapping summary for cli-backend.ts (Runner contract)
Spawn the binary, read stdout line-by-line as NDJSON, translate to AgentEvent:
| our AgentEvent | claude source | codex source |
|---|---|---|
| `text` | `assistant`→content `text` | `item.completed`→`agent_message.text` |
| `tool-start` | `assistant`→content `tool_use` | `item.*` command/tool start |
| `tool-end` | `user`→`tool_result` | `item.completed` command/tool result |
| `done` (+usage) | `result`.usage (+`total_cost_usd`) | `turn.completed`.usage |
| `error` | `result.is_error` / `error` | `item.type:"error"` |

Permissions/tools: the CLI runs ITS OWN (Gearbox's permission gate + tools don't
fire). For non-interactive runs pass the binary's own auto-approve
(claude `--permission-mode acceptEdits`/`--dangerously-skip-permissions`;
codex `--dangerously-bypass-approvals-and-sandbox` or a sandbox flag) and SURFACE
in the TUI that a CLI account self-governs. Session resume: claude `--resume <id>`,
codex thread resume — but cross-binary hand-off carries plain-text transcript only.
