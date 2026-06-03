#!/usr/bin/env python3
"""E-D2 — Code-retrieval benchmark on the REAL gearbox repo.

Ground truth: ~20 realistic tasks → the file(s) that must be edited (curated;
queries describe behavior, not filenames). Compares retrievers on recall@K
(higher = the right file surfaces in fewer retrieved files = fewer tokens):

  - lexical : ripgrep-style term frequency over file content + path (Cline-ish)
  - pagerank: Aider-style symbol-reference graph + personalized PageRank (SOTA)
  - hybrid  : my blend (normalized pagerank + lexical + path/symbol-name match)

Beat SOTA = hybrid recall@K > pagerank recall@K at the same K. Offline, free.
Run: python3 experiments/context/retrieval.py
"""
import os, re, math, json
import networkx as nx

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
SRC = os.path.join(ROOT, "src")

# ── curated ground truth: task → files that must change (behavior-described) ──
TASKS = [
    ("change which model is used by default", ["config.ts", "model/selector.ts"]),
    ("add support for a new model provider like xAI", ["providers.ts"]),
    ("let me approve a tool once but remember the choice", ["permission.ts", "ui/components/PermissionPrompt.tsx"]),
    ("pressing enter should insert a newline instead of sending", ["ui/input.ts"]),
    ("resume a previous conversation when I relaunch", ["session.ts"]),
    ("the code search tool misses files it should find", ["tools.ts"]),
    ("the assistant's markdown tables render wrong", ["ui/components/Markdown.tsx"]),
    ("the working indicator is distracting while it runs", ["ui/components/Working.tsx", "ui/components/Mascot.tsx"]),
    ("scrolling up through the transcript doesn't work", ["ui/App.tsx", "ui/components/Viewport.tsx"]),
    ("show how much the session has cost in dollars", ["providers.ts", "ui/components/StatusBar.tsx"]),
    ("the red and green colors under edits look off", ["diff.ts"]),
    ("summarize old turns when the conversation gets long", ["ui/lines.ts"]),
    ("display the current git branch in the footer", ["ui/git.ts", "ui/components/StatusBar.tsx"]),
    ("typing @ to attach a file should fuzzy-match", ["ui/mention.ts", "ui/files.ts"]),
    ("huge command output should be truncated", ["tools.ts"]),
    ("the spinner words while it works should rotate", ["ui/character.ts"]),
    ("exiting should restore my terminal cleanly", ["cli.tsx"]),
    ("the normalized event stream the UI consumes", ["agent/events.ts"]),
    ("run the model and stream its output as events", ["agent/run.ts"]),
    ("cap tool output and refuse paths outside the workspace", ["tools.ts"]),
]

STOP = set("the a an to is it of and or in on for with that this when should i me my be do does did into out up as at by".split())

def terms(s):
    parts = re.split(r"[^A-Za-z0-9]+", s)
    out = []
    for p in parts:
        for w in re.findall(r"[A-Z]+(?![a-z])|[A-Z][a-z]+|[a-z]+|[0-9]+", p):
            w = w.lower()
            if len(w) >= 3 and w not in STOP:
                out.append(w)
    return out

# ── index the repo ──
files = []
for dp, _, fns in os.walk(SRC):
    for fn in fns:
        if fn.endswith((".ts", ".tsx")):
            rel = os.path.relpath(os.path.join(dp, fn), SRC)
            files.append(rel)

content = {f: open(os.path.join(SRC, f), encoding="utf-8", errors="ignore").read() for f in files}
DEF_RE = re.compile(r"\b(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|enum)\s+([A-Za-z_][A-Za-z0-9_]*)")
defs = {}            # symbol -> set(files defining it)
file_defs = {f: set() for f in files}
file_idents = {}     # f -> list of identifier tokens
for f in files:
    for m in DEF_RE.finditer(content[f]):
        defs.setdefault(m.group(1), set()).add(f)
        file_defs[f].add(m.group(1))
    file_idents[f] = re.findall(r"[A-Za-z_][A-Za-z0-9_]*", content[f])

# file-reference graph (Aider-style): F -> B if F uses a symbol B defines
G = nx.DiGraph()
G.add_nodes_from(files)
for f in files:
    seen = {}
    for tok in file_idents[f]:
        if tok in defs:
            for b in defs[tok]:
                if b != f:
                    seen[b] = seen.get(b, 0) + 1.0 / len(defs[tok])
    for b, w in seen.items():
        G.add_edge(f, b, weight=w)

low_content = {f: content[f].lower() for f in files}

# document frequency per term → idf (BM25-ish): rare/specific terms count more.
N = len(files)
df = {}
for f in files:
    for t in set(re.findall(r"[a-z]{3,}", low_content[f])):
        df[t] = df.get(t, 0) + 1
def idf(t):
    return math.log(1 + (N - df.get(t, 0) + 0.5) / (df.get(t, 0) + 0.5))

def lexical_scores(q):  # BM25-weighted lexical (idf) + path/symbol-name boosts
    qt = terms(q)
    sc = {}
    for f in files:
        s = 0.0
        for t in qt:
            tf = low_content[f].count(t)
            if tf: s += idf(t) * (tf * 2.2) / (tf + 1.2)        # bm25 tf saturation
            if t in f.lower(): s += 4 * idf(t)                  # path match (idf-scaled)
            if any(t in d.lower() for d in file_defs[f]): s += 3 * idf(t)  # symbol-name match
        sc[f] = s
    return sc

def expand_scores(q, seeds=4, nbr=0.5):
    """My candidate: lexical seeds, then propagate score to graph neighbors —
    dependency-aware retrieval (pulls in the file a seed references / is referenced
    by, catching multi-file gold sets lexical alone misses)."""
    lx = lexical_scores(q)
    top = [f for f, _ in sorted(lx.items(), key=lambda kv: -kv[1])[:seeds]]
    sc = dict(lx)
    mx = max(lx.values()) or 1.0
    for s in top:
        boost = (lx[s] / mx)  # confident seeds propagate more
        for nb in list(G.successors(s)) + list(G.predecessors(s)):
            w = G.get_edge_data(s, nb, {}).get("weight", 0) + G.get_edge_data(nb, s, {}).get("weight", 0)
            sc[nb] = sc.get(nb, 0) + nbr * boost * mx * min(1.0, w / 3.0)
    return sc

def pagerank_scores(q):
    qt = terms(q)
    pers = {}
    for f in files:
        w = 1.0
        if any(t in d.lower() for t in qt for d in file_defs[f]): w += 8  # defines a query-named symbol
        if any(t in f.lower() for t in qt): w += 4                        # path matches
        pers[f] = w
    tot = sum(pers.values())
    pers = {k: v / tot for k, v in pers.items()}
    try:
        return nx.pagerank(G, personalization=pers, weight="weight")
    except Exception:
        return pers

def norm(d):
    mx = max(d.values()) or 1.0
    return {k: v / mx for k, v in d.items()}

def hybrid_scores(q, a=0.55, b=0.45):
    pr, lx = norm(pagerank_scores(q)), norm(lexical_scores(q))
    return {f: a * pr[f] + b * lx[f] for f in files}

def topk(scores, k):
    return [f for f, _ in sorted(scores.items(), key=lambda kv: -kv[1])[:k]]

def prf_scores(q):
    """Pseudo-relevance feedback: BM25 once, expand the query with the top file's
    own symbol names (the code's vocabulary), then BM25 again. Classic IR; free."""
    lx = lexical_scores(q)
    top = max(lx.items(), key=lambda kv: kv[1])[0]
    expansion = " ".join(list(file_defs[top])[:8])
    return lexical_scores(q + " " + expansion)

KEYS = {}
_envp = os.path.join(os.path.dirname(__file__), "..", ".env.local")
if os.path.exists(_envp):
    for line in open(_envp):
        m = re.match(r"^([A-Z0-9_]+)\s*=\s*(.+)$", line.strip())
        if m: KEYS[m.group(1)] = m.group(2)

def _haiku(prompt):
    import urllib.request
    body = json.dumps({"model": "claude-haiku-4-5", "max_tokens": 300, "messages": [{"role": "user", "content": prompt}]}).encode()
    req = urllib.request.Request("https://api.anthropic.com/v1/messages",
        data=body, headers={"x-api-key": KEYS.get("ANTHROPIC_API_KEY", ""), "anthropic-version": "2023-06-01", "content-type": "application/json"})
    j = json.load(urllib.request.urlopen(req, timeout=60))
    return j.get("content", [{}])[0].get("text", "")

def haiku_rerank_order(q, cand):
    """Strong-model retrieve-then-rerank: haiku reranks BM25 candidates using a
    CONTENT snippet of each (not just symbols)."""
    blocks = []
    for f in cand:
        head = "\n".join(content[f].splitlines()[:28])
        blocks.append(f"### {f}\n{head}")
    prompt = (f"Task: {q}\n\nWhich of these files must be EDITED for the task? "
              "Rank ALL of them from most to least likely, one path per line, exactly as the ### headers. Paths only.\n\n" + "\n\n".join(blocks))
    try:
        resp = _haiku(prompt)
    except Exception as e:
        return cand
    order = []
    for line in resp.splitlines():
        for f in cand:
            if f in line and f not in order: order.append(f)
    for f in cand:
        if f not in order: order.append(f)
    return order

def evaluate_rerank(name, base_fn, order_fn, topn=12):
    rows = {3: [], 5: [], 10: []}; ranks = []
    for q, gold in TASKS:
        cand = topk(base_fn(q), topn)
        ranked = order_fn(q, cand)
        for k in rows: rows[k].append(sum(1 for g in gold if g in ranked[:k]) / len(gold))
        rs = [ranked.index(g) + 1 for g in gold if g in ranked]
        ranks.append(min(rs) if rs else len(files))
    r = {k: sum(v) / len(v) for k, v in rows.items()}
    return name, r, sum(ranks) / len(ranks)

def evaluate(fn, name):
    rows = {3: [], 5: [], 10: []}
    ranks = []
    for q, gold in TASKS:
        sc = fn(q)
        ranked = [f for f, _ in sorted(sc.items(), key=lambda kv: -kv[1])]
        for k in rows:
            hit = sum(1 for g in gold if g in ranked[:k]) / len(gold)
            rows[k].append(hit)
        # mean rank of the first gold file found
        rs = [ranked.index(g) + 1 for g in gold if g in ranked]
        ranks.append(min(rs) if rs else len(files))
    r = {k: sum(v) / len(v) for k, v in rows.items()}
    return name, r, sum(ranks) / len(ranks)

print("\nE-D2 · code-retrieval benchmark (real gearbox src/, %d files, %d tasks)\n" % (len(files), len(TASKS)))
print("retriever   recall@3  recall@5  recall@10  mean-rank-of-gold")
print("──────────────────────────────────────────────────────────────")
import sys
results = []
methods = [(pagerank_scores, "pagerank(Aider)"), (lexical_scores, "lexical/BM25"), (expand_scores, "expand(mine)"), (prf_scores, "BM25+PRF(mine)")]
for fn, name in methods:
    nm, r, mr = evaluate(fn, name)
    results.append((nm, r, mr))
    print(f"{nm:<16} {r[3]*100:7.1f}%  {r[5]*100:7.1f}%  {r[10]*100:8.1f}%   {mr:6.1f}")
bm25_5 = next(r for n, r, _ in results if n == "lexical/BM25")[5]
if "--haiku" in sys.argv:
    print("running BM25 → haiku content rerank (paid, ~20 calls)…")
    nm, r, mr = evaluate_rerank("BM25+haiku rerank", lexical_scores, haiku_rerank_order, topn=12)
    results.append((nm, r, mr))
    print(f"{nm:<16} {r[3]*100:7.1f}%  {r[5]*100:7.1f}%  {r[10]*100:8.1f}%   {mr:6.1f}")
print()
best = max(r[5] for n, r, _ in results)
bestname = max(results, key=lambda x: x[1][5])[0]
print(f"best recall@5: {bestname} {best*100:.1f}%  (BM25 baseline {bm25_5*100:.1f}%)")
print(f"→ {'a method BEATS the BM25 baseline' if best > bm25_5 + 1e-9 else 'nothing beats plain BM25 here'}")
print()
