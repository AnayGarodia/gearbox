# Model data — tokenization & latency (measured)

The point of Gearbox is routing, and routing needs *data on the models*: how they
tokenize, how fast they are, what they cost, what they're good and bad at. This is
the measured part of that corpus. Numbers here are produced on this machine (Apple
Silicon, 2026-06) by the scripts in this directory; researched numbers (SWE-bench,
pricing) and the assembled profiles live in `src/model/profiles.ts`.

Reproduce:
```bash
bun run experiments/models/tokenize.ts   # needs ANTHROPIC_API_KEY in experiments/.env.local
bun run experiments/models/latency.ts     # + ollama w/ qwen2.5-coder:7b for the local row
```

## E-T · Tokenization: chars/4 is wrong, and wrong in the dangerous direction

Method: count the same samples three ways — `chars/4`, js-tiktoken `o200k_base`,
and the model's *real* tokenizer (Anthropic `/v1/messages/count_tokens`, exact and
free; ollama `prompt_eval_count` for the local model). Error is `(est − real)/real`,
so **negative = under-count = risks context-window overflow.**

| sample      | chars | chars/4 | tiktoken | Claude (real) | qwen (real) | chars/4 err | tiktoken err |
|-------------|------:|--------:|---------:|--------------:|------------:|------------:|-------------:|
| TS code     | 6000  | 1500    | 1575     | 1893          | 1566        | **−21%**    | −17%         |
| prose       | 6000  | 1500    | 1449     | 1699          | 1493        | **−12%**    | −15%         |
| tool output | 3840  | 960     | 1320     | 1846          | 1389        | **−48%**    | −28%         |
| JSON        | 3482  | 871     | 1265     | 1392          | 1582        | **−37%**    | −9%          |

Claude chars-per-real-token by content type: prose 3.53 · TS code 3.17 · JSON 2.50 ·
tool output 2.08. Structured/dense content tokenizes ~1.7× harder than prose, so a
single chars/N constant cannot be right for a coding agent (whose context is mostly
code + tool output, the two worst cases).

**Verdict.** chars/4 under-counts Claude by 12–48% — for tool output it sees less
than half the real tokens. Budgeting on it would silently overflow the window.
tiktoken o200k is much closer but still under-counts Claude (it's a *different*
tokenizer): Claude/tiktoken ratio = 1.10 (JSON) → 1.40 (tool output), mean ≈ 1.22.

**What we shipped** (`src/model/tokens.ts`): tiktoken o200k as the fast local base ×
a per-model **calibration** factor. Claude's factor is **1.35** — deliberately near
the dense-content top of the measured range rather than the mean, because
over-estimating is the safe direction (you leave headroom; you never overflow). The
exact count is one free `count_tokens` call away (`countTokensExact`) when precision
matters near the limit. Calibration is provenance-tagged in `profiles.ts`:
`claude 1.35 (measured)`, `tiktoken 1.0 (measured)`, `gemini 1.1 / deepseek 1.05
(seeded — to be measured when those keys are wired)`.

## E-L · Latency: TTFT and output throughput

Method: real streaming request, average of 3 trials. TTFT = wall-clock to first
content token; tok/s = output tokens ÷ (total − TTFT). Local model via ollama's
own reported timings.

| model                    | TTFT (ms) | out tok/s |
|--------------------------|----------:|----------:|
| claude-haiku-4-5         | ~1180     | ~190      |
| claude-sonnet-4-6        | ~1700     | ~95       |
| qwen2.5-coder:7b (local) | ~100      | ~18       |

(Run-to-run variance is real — a second run gave haiku 1176/190.9, sonnet 1697/94.9;
`profiles.ts` carries rounded representative values, tagged `measured`.)

**Verdict.** Haiku is ~2× Sonnet's throughput and noticeably faster to first token —
the measured basis for routing bounded, latency-sensitive sub-tasks (summarize,
classify, search-digest) to Haiku. The local 7B has near-zero TTFT (no network) but
low throughput; useful for instant, tiny, offline calls, not bulk generation.

## How this feeds routing

These are the first measured columns of the model corpus (`src/model/profiles.ts`),
alongside researched quality (SWE-bench Verified, intelligence index) and pricing.
Routing (later) scores over this table; for now the only live consumer is context
budgeting via the calibrated `countTokens`. Confidence is first-class: every field
is tagged measured / researched / seeded so the router never confuses a benchmark
guess for a measured fact. Open follow-ups: measure gemini/deepseek tokenizer
calibration and latency once those keys are configured.
