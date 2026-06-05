# Next steps

This file is the build order after `0.1.12`. Gearbox now has the core harness:
accounts, onboarding, routing, sessions, context curation, file/shell tools,
permission gates, URL fetch, web search, MCP loading, image-path attachments,
basic verification, `/init`, git context, and CLI-backed Claude/Codex accounts.

The next phase is not "add more random features." It is making every surface
already built work correctly across almost every common provider and model.

## Principle

Do not fake exact provider support with a hand-written list of model names.
Gearbox should know what a provider/model can actually do before routing to it:
tool calls, images, streaming, reasoning effort, JSON/schema output, context
window, max output, usage reporting, rate-limit headers, pricing, and error
shape.

If a capability is unknown, Gearbox should either test it, mark it unknown, or
avoid using it. It should not silently try the wrong request format.

## P0. Provider and model correctness

### 1. Model registry that can be trusted

Replace the current mostly static model registry with a discovered + curated
registry:

- Keep curated first-party rows for known flagship models, but attach provenance
  to every field: `official`, `api-discovered`, `user-configured`, or `seeded`.
- Add model discovery adapters where providers expose them:
  OpenAI-compatible `/models`, OpenAI, Google Gemini, Vertex, Bedrock, gateways
  such as OpenRouter, and local servers such as Ollama/LM Studio/vLLM.
- Persist discovery to `~/.gearbox/models.json` with timestamps, provider id,
  raw provider model id, normalized label, and capability flags.
- Let users add explicit custom models for providers that do not list models or
  hide private deployments, especially Azure/OpenAI-compatible enterprise setups.
- Hide or de-prioritize stale seeded rows when a provider returns a live model
  list that contradicts them.

Definition of done: `/model all` should say whether each row is live-discovered,
curated, or user-added, and Gearbox should not present unknown models as exact.

### 2. Capability matrix per model

Create a normalized `ModelCapabilities` record used by routing and runtime:

```ts
type ModelCapabilities = {
  text: boolean;
  streaming: boolean;
  tools: boolean | "unknown";
  images: boolean | "unknown";
  jsonSchema: boolean | "unknown";
  reasoningEffort: false | string[];
  systemPrompt: boolean | "unknown";
  usage: "exact" | "partial" | "none";
  contextWindow?: number;
  maxOutputTokens?: number;
  pricing?: { input: number; output: number; source: string };
};
```

This matrix must be checked before every model call. Examples:

- Image attachments only route to models with `images: true`.
- MCP/file/shell tool turns only route to models with `tools: true`.
- `/effort` only appears when `reasoningEffort` is supported.
- Cost and budget views distinguish exact pricing from seeded estimates.

Definition of done: a model cannot be selected for a turn it cannot execute.

### 3. Provider conformance tests

Add a live provider test harness:

```bash
gearbox doctor providers
gearbox doctor provider openai
gearbox doctor model gpt-5.5
```

Each configured provider should run small, bounded checks:

- Text completion.
- Streaming completion.
- Tool call with `read_file`.
- Tool denial path.
- Tool result continuation.
- Image input when the model claims vision.
- JSON/schema response when supported.
- Reasoning effort option mapping when supported.
- Usage parsing and cost estimate.
- 429/rate-limit/error normalization.

The output should be a matrix, not prose:

```text
provider   model          text stream tools image effort usage  status
openai     gpt-5.5        yes  yes    yes   yes   high   exact  ok
ollama     qwen2.5-coder  yes  yes    no    no    no     none   usable
gateway    custom-model   yes  yes    ?     ?     no     partial needs-smoke
```

Definition of done: before release, the harness has live smoke results for the
main provider families and fixture tests for every normalization path.

### 4. Provider-specific request normalization

Centralize provider quirks instead of scattering them through the app:

- One option mapper for reasoning effort.
- One message/capability mapper for image parts and tool calls.
- One usage parser.
- One error classifier for auth, rate limit, quota, context overflow,
  unsupported feature, network, and provider outage.
- One retry policy for transient failures.

The AI SDK covers the common path, but Gearbox still needs its own compatibility
layer because OpenAI-compatible providers do not all support the same subset of
the OpenAI wire protocol.

Definition of done: provider errors become actionable Gearbox errors, not raw
SDK/provider blobs.

### 5. Routing that respects capability, health, and account reality

Upgrade routing from "cheapest model over a seeded list" to a real candidate
pipeline:

1. Filter by configured account/provider availability.
2. Filter by required capabilities for the turn.
3. Filter out unhealthy providers from recent doctor/health checks.
4. Prefer subscription CLI seats when they can satisfy the task and have
   headroom, because marginal cost is effectively zero.
5. Apply quality threshold for the task.
6. Apply user preference and repo priors.
7. Apply budget, balance, and rate-limit scarcity.
8. Pick the best cost/latency tradeoff and show why.

Definition of done: a routing line can explain the decision in plain English:
`sonnet-4.6 · tools+image required · Claude subscription has headroom`.

## P1. Upgrade the surfaces already built

### MCP support

Current: stdio MCP servers load from config and become model tools.

Next:

- Validate MCP config with a schema and show exact errors.
- Add Streamable HTTP/SSE transport in addition to stdio.
- Add `gearbox mcp doctor` with connection status, tool count, latency, and
  failed-server diagnostics.
- Support per-server env files and explicit secret references without printing
  secrets.
- Detect tool-name collisions and show the final mapped tool name.
- Cache tool schemas but refresh on command.
- Treat MCP permissions as first-class: read-only tools in plan mode, risky
  tools behind the permission gate, server-level disable/allow lists.

### Image and screenshot input

Current: pasted or dragged local image paths attach to API-backed multimodal
models.

Next:

- Add clipboard image ingestion where the terminal/platform exposes it.
- Add HEIC/TIFF conversion on macOS screenshots where possible.
- Downscale or recompress large images before sending, with a visible notice.
- Support multiple images with stable transcript chips.
- Persist attachment metadata, not raw bytes, in sessions.
- Route image turns only to models proven to support images.
- When a subscription CLI backend is active, either pass images through if the
  CLI supports it or give a precise unsupported message.

### Web search and URL fetch

Current: URL fetch and `web_search` exist.

Next:

- Search result -> fetch pipeline: search gives URLs, then the agent can fetch
  selected pages automatically.
- Add provider choice/status to `web_search`: Brave, SearXNG, DuckDuckGo.
- Add result freshness/date extraction when available.
- Add source snippets to the transcript when search materially affects an answer.
- Add timeout/backoff and clearer "search provider unavailable" errors.

### Onboarding and accounts

Current: first-run onboarding blocks app launch until an account is configured;
API keys, env/cloud imports, Azure, and Claude/Codex CLI accounts work.

Next:

- Run a provider smoke test during onboarding and store the result.
- Show exact supported capabilities after adding an account.
- Offer model discovery immediately after adding a provider.
- Make local providers first-class: detect Ollama, LM Studio, vLLM, llama.cpp.
- Add `gearbox doctor` as the standard recovery path when setup fails.

### Verification

Current: Gearbox detects common checks and runs verification after file changes.

Next:

- Make verification non-blocking.
- Add affected-test detection.
- Add a bounded auto-fix loop when verification fails.
- Add `/verify`, `/verify full`, and `/verify ci`.
- Store verification history per session and use it in the final summary.

### Editing and shell

Current: exact replacement edit, file write, shell command, permission gate.

Next:

- Replace fragile exact edits with structured patch application.
- Add persistent shell session support so `cd`, `export`, and `source` persist.
- Add command allow/deny policy in config.
- Add true undo for the last turn: revert file changes and remove the turn from
  model history.

### Sessions and context

Current: sessions persist, context is curated, git context and project memory are
injected.

Next:

- Add context pinning: `@pin path`, `/pins`, `@unpin path`.
- Add session handoff summary.
- Add scoped memory: user, project, session.
- Add automatic fact extraction with undo.
- Add decision-preserving compaction.

## P2. Features that make Gearbox clearly better

### Rate-limit failover

When a model hits 429/quota/provider outage, retry the same turn with the next
compatible candidate. The transcript should say what happened and why the next
model was chosen.

### Budget and savings

Add session/daily/task caps, pre-send cost estimates, saved-vs-baseline cost, and
cached-token savings where providers report them.

### Independent review

Add `/review` and automatic reviewer subagent for larger diffs. The reviewer
sees the diff independently, not the main agent's reasoning.

### Worktree orchestration

Use scratchpad or branch worktrees for risky or exploratory tasks. Later, add
parallel subagents for independent tasks.

## Compatibility release gate

Do not call the next release "provider complete" until this gate passes:

- `bun test`
- `bun run typecheck`
- `bun run build`
- `gearbox doctor providers` against at least one account from each family:
  native SDK, OpenAI-compatible API, gateway, cloud, local OpenAI-compatible,
  and CLI subscription.
- A recorded matrix showing text, stream, tools, images, usage, errors, and
  reasoning effort for the smoke-tested models.
- README documents the exact support level: supported, partial, unknown, or
  user-configured. No overclaiming.

## Most obvious missing table-stakes items

The biggest gaps, in order:

1. Live model discovery and capability gating.
2. Provider/model doctor with a visible compatibility matrix.
3. Rate-limit and provider-outage failover.
4. Robust structured editing instead of exact string replacement.
5. Persistent shell sessions.
6. Non-blocking verification with auto-fix loop.
7. Context pinning and session handoff summaries.
8. Budget caps and visible savings.
9. MCP doctor + HTTP transport.
10. True undo.
