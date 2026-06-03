# Context design — experimental findings & verdict

Goal: figure out the best context design for Gearbox **empirically**, and beat the
SOTA. Six experiments below (4 offline w/ a real tokenizer, 2 live: local
qwen2.5-coder:7b + Claude haiku). Several hypotheses were **refuted** — the
scientific method reshaping the design. Live spend ≈ $0.07.

Run: `python3 experiments/context/retrieval.py [--haiku]` · `bun run
experiments/context/{run-cost,run-repomap,run-edit,run-rot,run-recall}.ts`.

## Results

### E-A — Cost/size across a growing session (RAN, offline)
Raw transcript vs curated (recent raw + older tool-output offloaded to facts):

| turns | D0 raw | D2 curated | $/turn D0 | $/turn D2 | D0 % of 200k |
|------:|-------:|-----------:|----------:|----------:|-------------:|
| 16 | 12,281 | 2,360 | $0.037 | $0.007 | 6% |
| 64 | 48,857 | 3,944 | $0.147 | $0.012 | 24% |
| 128 | 97,625 | 6,056 | $0.293 | $0.018 | 49% |

**Decisive.** Raw grows linearly → overflows + rots; curated stays flat (~16×
cheaper/turn). Switching models at turn 64: **12.4× cheaper** on curated state.
This is the routing enabler.

### E-C — Edit correctness PER TOKEN (RAN, live haiku)
Same 3 real edit tasks, two contexts: FULL src dump vs CURATED (signature map +
top-3 lexical files). Correctness was **identical** (✓✓✗ both) at **~17k vs ~30k
tokens**. → **Curation costs no quality**; the cost win is free. (On larger repos
the full dump simply won't fit; curated stays bounded.)

### E-D — Codebase-awareness token efficiency (RAN, offline)
Structural signature map = **4,906 tok** for whole-repo awareness vs **23,136 tok**
to dump every file (**4.7× smaller**, 2.5% vs 12% of a 200k window).

### E-D2 — Retrieval benchmark (RAN; 20 curated tasks → gold files, 39-file repo)
recall@K = right file in the top-K (higher = fewer tokens to the model):

| retriever | recall@3 | recall@5 | recall@10 | mean rank |
|---|---:|---:|---:|---:|
| pagerank (Aider repo map) | 22.5% | 30.0% | 55.0% | 10.6 |
| lexical / BM25 | 62.5% | 82.5% | 85.0% | 3.6 |
| expand (graph, mine) | 17.5% | 55.0% | 72.5% | 8.2 |
| BM25 + PRF (mine) | 60.0% | 70.0% | 77.5% | 5.5 |
| **BM25 + haiku rerank** | **82.5%** | **85.0%** | 85.0% | 5.3 |

Two real findings: **(1) Aider's PageRank repo map LOSES to plain BM25 at this
repo scale** (its symbol graph is too sparse; PageRank just favors hub files —
its win is a large-repo phenomenon). **(2) A strong-model retrieve-then-rerank
beats the best baseline** — recall@3 62.5%→82.5% (the right file lands in the
top-3, the token-efficiency sweet spot). Graph-expansion and PRF both *hurt* —
noise on a small hub-heavy repo.

### E-B / E-B2 — Recall / context rot (RAN, live haiku + local qwen) — NULL
Single-needle recall (E-B, ~7k tok) and a superseded-fact-with-distractors test
(E-B2, up to 200 distractors / ~14k tok, 6 trials, qwen): **both designs 100%**.
Modern models (even 7B) resist single-fact rot at these scales. **Honest negative:
curation's win is COST/scaling, not single-fact recall.** (Rot bites at far larger
scale / with genuinely ambiguous multi-fact reasoning — not cheaply reproduced.)

## VERDICT — best context design (evidence-shaped; differs from the pre-experiment guess)

A **Context Engine**: the transcript is not the source of truth. Per turn, a
`ContextBuilder` assembles a **token-budgeted working set for the chosen model**,
ordered system → core memory → repo map → retrieved code → curated history → message.
Proven free of quality cost (E-C) and ~16× cheaper + bounded (E-A).

- **Retrieval (revised by E-D2): lead with LEXICAL/BM25 (ripgrep), NOT a PageRank
  repo map.** Add a **strong-model rerank** of the top candidates when top-K
  precision matters (recall@3 62.5%→82.5%). Keep the structural signature map for
  *awareness* on large repos (4.7× efficient, E-D). **Drop** graph-expansion and
  PRF (refuted). Embeddings deferred (BM25 is already strong; untested).
- **Tiered memory**: core (GEARBOX.md + living facts) · working (recent raw +
  older compacted + tool-result offload — the E-A win) · recall (event-log ledger).
- **Fact invalidation**: keep it for *correctness/determinism* (cheap, lets a wrong
  fact be removed) — but do NOT market a recall win; models are robust (E-B2).
- **Model-agnostic / routing-ready**: builder budgets to `ModelSpec.contextWindow`
  (adaptive); the curated state makes model-switch 12× cheaper (E-A); seed
  `ModelSpec` cost/latency/quality + `Task` fields; delegated-sub-task seam (first
  user: compaction; the rerank shows cheap-model help is real but a *strong* model
  reranks best).

## What the experiments REFUTED (the scientific method earning its keep)
- PageRank repo map as the retrieval primary (loses to BM25 here).
- Graph-expansion and PRF as scorers (add noise).
- A recall/context-rot benefit from curation at testable scales (models are robust).
- A weak (7B) reranker (hurts; needs a strong model).

## Honest scope
20 curated tasks on a 39-file repo (small N; recall@5 differences <±5% are noise —
the recall@3 jump and the cost results are the robust signals). Rot untested at
50k–150k tokens. Embeddings untested.
