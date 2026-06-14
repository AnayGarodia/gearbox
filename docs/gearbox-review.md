# Gearbox — Review, Competitive Ranking, and Roadmap

*A multi-provider terminal coding agent whose real thesis is per-task model routing: for every turn, pick the cheapest model — across every provider and subscription you pay for — that still clears a quality bar derived from the cost of being wrong.*

---

## 1. What it is

Gearbox is a terminal coding agent (Bun + TypeScript + Ink, ~38k lines, 169 test files). It reads and writes code, runs commands, and talks to ~25 providers (Anthropic, OpenAI, Google, DeepSeek, OpenRouter, Groq, xAI, Mistral, Moonshot, Z.ai, Azure, Bedrock, Vertex, gateways, any OpenAI-compatible endpoint) through one clean loop.

The point isn't "another agent." It's **intelligent per-task model routing**: automatically choosing the right model for each task across every model and account you already pay for. Everything else — the UI, accounts, context engine, parallel tabs — is infrastructure serving that one idea.

---

## 2. How it works (the mechanics)

### The routing engine (the core)

The design rule that matters: the agent never hardcodes a model. It asks a selector for one. The flow each turn is **classify → quality bar → candidate pairs → score → cheapest winner**.

- **Classify the task** (cheap, fast): keyword fast-path → context stickiness → cached verdict → a cheap-model fallback. Hard work is never silently downgraded.
- **Candidates are `(model, account)` pairs**, not just models — including flat-rate **subscription seats** (your Claude/Codex CLI logins). This is the key move nobody else makes.
- **The scorer is pure and economic.** A subscription seat nets to roughly *free* until its rate-limit window fills, then it fails over to metered API. The bar a model must clear scales with the **cost of being wrong**: with tests present, a wrong answer costs ~$0.10 to catch and retry; with no verifier, ~$2 of wasted spend. So "cheap-first in well-tested repos, careful-first otherwise" *emerges* from the economics rather than a hardcoded rule.
- **The flywheel (self-correction):** every test/verify outcome (and every undo) is recorded per-repo, per-(task-kind, model). After enough data, a model that keeps failing *in this repo* gets pushed below the bar *here*. Routing gets better the more you use it, per project.

### Reliability by design

- **Live failover:** if a model is rate-limited, out of credit, or expired *before any output streamed*, the failed account is parked on a cooldown, the router re-picks around it (possibly a different provider entirely), and the turn continues — up to 2 hops, narrated plainly. Never hops after output has started.
- **One spend writer:** every dollar flows through a single ledger. Subscription seat = $0 marginal; provider-reported cost when available; otherwise a cache-aware estimate. No invisible billing.
- **Exact subscription usage with no token read:** Gearbox reads your real Claude/Codex plan usage % by driving the vendor's own status mechanism, not by spending a token.

### The rest of the harness

- **VERIFY:** after any edit, detect the project's checks (tests/typecheck/build), run them as a gate, report the proof tier honestly, and auto-iterate to green (≤3 tries). A language-server fast tier runs first.
- **Context engine:** a cache-stable system prefix plus a per-turn block of retrieved files (lexical + optional semantic) and git state, budgeted to the model's window, with a compaction ladder for long sessions.
- **Total undo:** a whole-tree snapshot at the first change of each turn, so even shell-side deletes are reversible.
- **Sandboxed shell** (seatbelt on macOS, bubblewrap on Linux), a permission broker with project rules, MCP support, plugins, and sub-agents.
- **Conductor:** parallel sessions as tabs, each a full agent bound to its own git worktree, all running at once.

---

## 3. Competitive ranking

Three categories of product: **harnesses** (the agent you run), **gateways** (a routing API you point a harness at), and **hybrids** (a harness with built-in routing). Gearbox is the only thing that is a hybrid, **local**, and **account-aware**.

### Overall terminal harness (general purpose, today)
1. Claude Code
2. Codex CLI
3. OpenCode
4. Factory Droid
5. Gemini CLI
6. Aider
7. Crush
8. Amp
9. Goose
10. Qwen Code
11. OpenHands (CLI)
12. **Gearbox** — Tier-1 engineering, ranked low only on adoption/proof

### Automatic / economic model routing (Gearbox's axis)
1. **Gearbox** — the only one that is local, multi-account, subscription-seat-aware, and self-correcting per repo
2. OpenRouter — Auto Router + coding-score router + a cost/quality dial
3. Martian — adaptive router that learns from traffic (closest idea to the flywheel, but hosted, model-choice only)
4. Factory Router — in-harness cost routing, ~20–25% savings claim, but closed and Factory-billed
5. NotDiamond — the routing model that powers others
6. Portkey / LiteLLM — rule-based routing and cost controls
7. Everyone else (OpenCode/Crush/Aider) — manual model selection, no auto-routing

### Multi-provider breadth (as a harness)
1. OpenCode (75+) · 2. Aider (any) · 3. Crush · 4. **Gearbox** (~25 + cloud + subscription seats + any compatible endpoint) · 5. Goose · 6. Qwen Code · (single-vendor: Claude Code / Codex / Gemini)

### Harness depth (verify / undo / context / sandbox / language-server)
1. Claude Code · 2. **Gearbox** (deep, on design; unproven at scale) · 3. OpenCode · 4. Factory Droid · 5. Codex CLI · 6. Aider · 7. Crush · 8. Goose

### Autonomous capability (hands-off / benchmark)
1. Factory Droid · 2. Codex CLI · 3. Devin · 4. Claude Code · 5. OpenHands · 6. Cursor · 7. Amp · 8. Gemini CLI
*(Gearbox: N/A — autonomy is whatever model it routes to.)*

### Ecosystem & extensibility
1. Claude Code · 2. Cursor · 3. OpenCode · 4. Goose · 5. Factory Droid · 6. Cline · 7. **Gearbox** (has the pieces, no community)

### Adoption & maturity (terminal tools)
1. Claude Code · 2. OpenCode (~171k★) · 3. Codex CLI · 4. Aider · 5. Gemini CLI · 6. Factory Droid · 7. Amp · 8. OpenHands · 9. Goose · 10. Qwen Code · 11. **Gearbox** (near-zero, solo)

### Terminal UX / craft
1. Crush · 2. Claude Code · 3. **Gearbox** (parallel tabs, mascot, virtualized buffer, click zones) · 4. OpenCode · 5. Warp · 6. Codex CLI

### Value / lowest spend per task
1. **Gearbox** (free, bring-your-own-keys, routes to the cheapest capable account incl. free seats — best *design*; unproven) · 2. Factory Droid ($20 flat covers Claude+GPT+Gemini) · 3. Amp (free, daily cap, no markup) · 4. Gemini CLI · 5. OpenCode / Aider / Crush

### Separate categories (Gearbox doesn't compete here)
- **IDE / editor agents:** Cursor · GitHub Copilot · Windsurf · Zed · Cline · JetBrains Junie · Trae · Roo/Kilo · Cody
- **LLM routers / gateways (infra, not agents):** OpenRouter · LiteLLM · Portkey · Martian · Vercel AI Gateway · NotDiamond · Requesty/Helicone

### Where Gearbox sits
It wins the axis it was built for (economic, account-aware routing) and the engineering that supports it; it loses every axis that takes time and users to earn. The only rivals that threaten its core claim are hosted gateways (OpenRouter, Martian) — but they optimize *which model*, never *which of my accounts/seats*, and don't live inside the agent loop with test feedback. That quadrant is still Gearbox's alone:

> "I pay for a Claude Max seat AND a ChatGPT plan AND have a few API keys, and I want one local agent to spend the cheapest one that'll still get it right — learning from what fails in *this* repo."

Nothing else does that.

---

## 4. Roadmap — what to build next

Gearbox already has near-complete table-stakes parity. The gap isn't features. It's **proof, distribution, and two surface plays** — in that order.

### Do first (nothing else matters until this ships)
1. **Prove it saves money.** Run a fair test: same batch of real coding tasks through Gearbox vs a normal single-model setup, and report two numbers — how many tasks finished correctly, and how much each spent. That one chart is the entire pitch, and it's the one thing missing. Competitors already market savings numbers; Gearbox can't be evaluated without its own.
2. **Get a public benchmark score** (Terminal-Bench / SWE-bench Verified) for Gearbox-with-routing. Even a middling absolute score is fine if the cost-per-task ratio is great — that ratio is the story.

### Then (so people don't bounce on day one)
3. **Run unattended.** Hand it a bug report or task and let it write the fix, run the tests, and open a pull request with nobody watching — including in CI, where saving money matters most.
4. **Make the model-picking trustworthy.** Always show, at a glance, whether it's auto-picking or locked to one model, and let users set guardrails so it asks before spending on an expensive pick. *(In progress — see below.)*
5. **Session sharing/export** — cheap, and a proven way these tools spread.

### Later (where the market is heading)
6. **Work inside a code editor** via the agent-client protocol already scaffolded — puts the routing inside an IDE without building an IDE.
7. **Background "leave it running" agents** — people now expect to fire a task and close the laptop.
8. **Named lifecycle hooks** — formalize the plugin system into a documented hook surface (a real ecosystem draw).

### Deepen the moat
9. **A savings dashboard** — "you saved $X this month vs single-model, here's the per-task-type breakdown." Generated for free from the spend ledger; it's exactly what gateways charge for.
10. **Committable team routing policy** — one shared routing brain per repo.

**Recommendation:** do 1, 2, 3 and nothing else first. The benchmark plus an unattended/CI mode turn the one true differentiator into something a stranger can verify and deploy where it pays off most. Everything else is premature until someone believes the routing works.

---

## 5. In progress: trustworthy model-picking

The current build already lets you **lock to one model** (`/model <name>`, back to `/model auto`), already **shows the pick** in the status bar, explains it on demand, and flags surprising picks. Two pieces are being added:

- **Always-visible state:** an unmistakable *auto vs locked* indicator, so you always know whether something else is choosing.
- **Spending guardrails:** soft rules that interrupt and ask *only when crossed* (e.g. before an expensive model, or a high estimated turn cost) — the softer companion to the existing hard `/cap` ceilings.
