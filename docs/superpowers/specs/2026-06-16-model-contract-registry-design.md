# Model Contract Registry — correct-by-construction provider support

Date: 2026-06-16
Status: phase 1 implemented (contract surface selection + error taxonomy); data/discovery follow-ups tracked below.

## Problem

Gearbox hand-wires per-provider quirks, so a model that needs a contract Gearbox
doesn't encode fails on the FIRST call. The trigger: Azure AI Foundry **codex**
deployments answer only the **Responses API**; Gearbox's openai-compatible path
only POSTs `/chat/completions`, so `gpt-5.3-codex` returned *"The requested
operation is unsupported."* Codex is one instance of a whole family of quirks
(API surface, token-param name, dropped params, system-role style, reasoning
shape, streaming support, model-id/endpoint addressing, error-envelope shape).

The goal: **correct by construction.** Build the right request the first time
because the harness *knows* each model's contract — no runtime retries, no
"self-healing."

## Architecture

Declarative data in pure modules; `providers.ts` reads them and builds the exact
request. Stable FORMATS and FAMILY RULES are hardcoded; VOLATILE data (exact ids,
prices) is discovered + provenance-tagged so it can't rot.

| Module | Responsibility |
|---|---|
| `src/model/contract.ts` | `contractFor(provider, modelId) → RequestContract`: surface, token-param, dropParams, systemRole, reasoning shape+vocab+force, tempClamp, noStream. Ordered family-pattern rules (first match wins) + provider defaults. **Implemented.** |
| `src/model/error-taxonomy.ts` | `classifyError(err) → {class, kind, scope}`: envelope-aware (7 shapes), branches envelope→name/code→substring→status. **Implemented.** |
| `providers.ts resolveModel` | consults `contractFor` to select `.responses()` vs chat factory. **Implemented.** |
| `src/model/profiles.ts` / `pricing.ts` | complete cost data (in/out/cached, per-request fees, long-context tiers), provenance-tagged. *Follow-up — data encode.* |
| `src/accounts/discover.ts` | `GET /v1/models` + capability probe for volatile catalogs (hosts/local/Groq/Cerebras/SambaNova). *Follow-up.* |

## The two load-bearing invariants (proven across all 35 providers)

1. **Classify failures by envelope, never HTTP status.** Bedrock returns 400 for
   throttling; Vertex and MiniMax put the failure in a 200 body; OpenAI splits
   429 into retryable rate-limit vs non-retryable quota by `code`, Azure
   collapses both to "429". `error-taxonomy.ts` detects the envelope first.
2. **Discover + provenance-tag volatile data; hardcode only formats + rules.**
   Every host's 2024–25 flagship slugs have rotated by mid-2026. Bake the id
   FORMAT and the family rule; pull ids/prices live.

## Family-pattern rule table (implemented in contract.ts)

First match wins; family resolved from the canonical model id (Azure deployment
names are arbitrary).

| Pattern (provider scope) | Surface | Token param | Drop | Role | Effort | Stream |
|---|---|---|---|---|---|---|
| `codex-mini`, `gpt-5.1+-codex(-max/-mini)` (openai/azure) | responses | max_output_tokens | drop-8 | developer | low/med/high(+xhigh) | ✅ |
| `gpt-5-codex`, base `codex` | responses | max_output_tokens | drop-8 | developer | low/med/high | ❌ |
| `o3-pro` | responses | max_output_tokens | drop-8 | developer | force high | ❌ |
| `gpt-5(.x)-pro` | responses | max_output_tokens | drop-8 | developer | force high | ✅ |
| `o1-mini` | chat | max_completion_tokens | drop-8 | developer | none | ❌ |
| `o1` | chat (+resp) | max_completion_tokens | drop-8 | developer | low/med/high | ❌ |
| `o3`,`o3-mini`,`o4-mini` | chat (+resp) | max_completion_tokens | drop-8 | developer | low/med/high | ✅ |
| `gpt-5.1+` | chat (+resp) | max_completion_tokens | drop-8 | developer | none/low/med/high | ✅ |
| `gpt-5`,`-mini`,`-nano` | chat (+resp) | max_completion_tokens | drop-8 | developer | minimal/low/med/high | ✅ |
| `gpt-4o`,`gpt-4.1`,`gpt-4`,`gpt-3.5` | chat | max_tokens | — | system | — | ✅ |
| `claude*` (anthropic/bedrock/vertex) | messages | max_tokens | top_k | system | anthropic-thinking | ✅ |
| `gemini*` (google/vertex) | gemini | maxOutputTokens | — | system | google-thinking | ✅ |
| `*r1*`,`*reasoner*` | chat | max_tokens | logprobs | system | always-on (reasoning_content) | ✅ |
| `grok-*-reasoning` (xai) | chat | max_completion_tokens | penalties+stop | system | variant-id | ✅ |
| `grok-3-mini`,`grok-4.3` (xai) | chat | max_completion_tokens | penalties+stop | system | none/low/med/high | ✅ |
| *default* | chat | max_tokens (max_completion for xai/groq/cerebras/nebius) | — | system | none | ✅ |

drop-8 = `temperature, top_p, presence_penalty, frequency_penalty, logprobs, top_logprobs, logit_bias, max_tokens`.
Temp clamps in defaults: moonshot/zai/together [0,1], mistral [0,0.7].

## Error envelope → class (implemented in error-taxonomy.ts)

| Envelope | Detect by | Examples |
|---|---|---|
| OpenAI wire | `error.{code,type}` | insufficient_quota→quota, rate_limit_exceeded→rate-limit, context_length_exceeded, model_decommissioned→model-gone |
| AWS exception | `__type`/`name` ends `Exception` | ThrottlingException(400!)→rate-limit, ValidationException+"on-demand throughput"→model-gone, ExpiredToken→auth |
| Google RPC | `error.status` SCREAMING_SNAKE | RESOURCE_EXHAUSTED→rate-limit, NOT_FOUND→model-gone, PERMISSION_DENIED→auth |
| MiniMax | `base_resp.status_code` in a 200 | 1008→quota, 1002→rate-limit, 1004→auth |
| Content filter | substring, any provider | →content-filter (NEVER a failover hop) |

Classes map to the existing cooldown buckets: quota/auth → park account; rate-limit/server → cool (account,model) pair; content-filter/context-length/model-gone/bad-request → no hop.

## Per-provider research (full tables in PR thread / git history)

35 providers researched and cited: OpenAI/Azure/Foundry (responses matrix), Anthropic
(4 routes: direct/Bedrock-legacy/Bedrock-mantle/Vertex + thinking/caching shapes),
Bedrock+Vertex non-Anthropic (inference-profile id rules, Gemini-3 global-only),
DeepSeek/Moonshot/Z.ai/MiniMax, xAI/Mistral/Groq/Cerebras/Perplexity, the 5 gateways
(OpenRouter/Vercel/Portkey/Requesty/LiteLLM — id formats, cost-source, no-credits codes),
8 inference hosts (id formats, reasoning fields), 4 local runtimes (discovery + capability probe).

## Verification

- `bun test test/contract.test.ts test/error-taxonomy.test.ts` — 30 pass.
- `bun test test/` — 1702 pass, 0 fail (no regressions).
- `tsc --noEmit` — clean.
- **Live**: `gpt-5.3-codex` on the real `aztea-foundry` account via the
  `/openai/v1/responses` surface that `resolveModel` now selects → `status:
  completed`, output `"works"`. The chat-completions path returned the reported
  error; the new path succeeds.

## Follow-ups (tracked, not in this PR)

1. **Request shaping in run.ts** — apply `dropParams` / token-param rename /
   role mapping for the openai-compatible crowd (the AI SDK handles native
   openai; compat providers need the shaper).
2. **Adopt `error-taxonomy.classifyError`** in the App hop-loop (it has the raw
   error object; `cooldown.classifyFailure` only sees the message string).
3. **Encode pricing** from the research into `profiles.ts` + a `pricing.ts` with
   per-request (Perplexity) and long-context-tier terms.
4. **Discovery probe** for volatile catalogs + local capability detection.
5. **Addressing module** — consolidate Bedrock geo-prefix + Vertex global rules
   (already partly in `providers.ts`) into `addressing.ts`.
