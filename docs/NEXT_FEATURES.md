# Next features

Ordered by priority. These ship before any subscription or public launch.

## 1. Rate limit failover
**What:** When a call hits a 429 or rate-limit error, automatically re-select a model (excluding the failed one) and retry the same turn without user intervention. Show a transcript line: "anthropic rate-limited → switching to deepseek-v4-pro, continuing."
**Where:** `App.tsx` runner function — catch the error before surfacing it to the UI, call `selector.select()` again with an exclusion list, re-run `runTask`.
**Why first:** The only feature no other tool has. Without it, multi-provider is just a config option, not a working feature.

## 2. Per-turn routing line in transcript
**What:** At the start of each assistant response, show a dim one-liner: `→ haiku-4-5 · search · $0.001`. Makes routing visible and tangible instead of silent.
**Where:** `run.ts` — emit the `model-pick` event (already defined in `events.ts`, never fired). `Transcript.tsx` — render it as a dim routing line.
**Why:** Routing happens invisibly right now. Users can't see or feel it working. This single line is the product pitch made visible.

## 3. Savings shown in `/cost`
**What:** Add one line to the cost view: "saved vs all-sonnet: $X.XX". Compute it from actual spend + token counts × price delta (all data already in `usage.ts`).
**Where:** `commands.ts` + `accounts/usage.ts` `buildUsageView`.
**Why:** The product pitch is "saves you money." Without this users have to do the math themselves.

## 4. First-run onboarding screen
**What:** When no accounts or keys are detected on startup, show a clear setup screen instead of silently falling into demo mode. Tell the user exactly what to do: which env vars to set, or run `gearbox auth add <key>`.
**Where:** `App.tsx` — detect no accounts on mount, render a setup prompt before the main UI.
**Why:** The biggest friction point for a new user is getting past the first launch.

## 5. Preference suggestion after a good turn
**What:** After routing picks a model for a task kind and the turn finishes cleanly, show a dim suggestion: "routing picked haiku for search — `/prefer search haiku` to always use this." One suggestion per task kind, never repeated.
**Where:** `App.tsx` — after `runTask` completes, emit `preference-suggestion` event (already defined in `events.ts`, never fired). `Transcript.tsx` — render it.
**Why:** Makes routing personalize over time without a full flywheel. The infrastructure is already there, just not wired.

## 6. Verify all providers work end-to-end
**What:** Test a full multi-turn session with real tool calls on DeepSeek, Gemini, and OpenAI. Fix whatever breaks (tool-calling format differences, streaming quirks, error message shapes).
**Where:** `providers.ts`, `accounts/resolve.ts`, `agent/run.ts`.
**Why:** The multi-provider claim is hollow if only Anthropic works reliably. One broken tool call on a first try and the user leaves.

---

## 7. Auto git commit after successful changes
**What:** After the agent writes or edits files and the turn finishes cleanly (no errors), automatically run `git add` + `git commit` with a short descriptive message generated from what the agent did. Opt-out via `/config autocommit off`. Show the commit SHA in the transcript.
**Where:** `App.tsx` — after `runTask` resolves, check if any write/edit tools ran, generate a commit message, run via `run_shell`.
**Why:** Aider's most-loved feature. Every change becomes reversible with a standard `git log`. Removes the biggest fear of letting an agent write code: "what if it breaks something and I can't undo it."

## 8. Smart background verification — type-check, affected tests, and CI
**What:** After a turn that edited files, run verification in the **background** — the turn completes immediately, you can type your next prompt, and results appear as a follow-up transcript item when ready. Because it's fully non-blocking, it can handle anything: fast checks in seconds, full test suites in minutes, or long CI pipelines running for 10+ minutes. Four tiers, tried in order unless configured otherwise: (1) type-check only (`tsc --noEmit`, `pyright`, `mypy` — 2–5s, catches most errors); (2) affected tests only (static import analysis to find test files covering changed files — faster than the full suite); (3) full test suite; (4) CI trigger (push to a branch, kick off GitHub Actions / CircleCI, poll for result, surface pass/fail when done). `/verify` triggers manually at any time. `/verify ci` forces the CI tier.
**Where:** New `src/verify.ts` — detect checker from project files, run via `run_shell`, emit the `verification` event (already defined in `events.ts`). CI polling via the GitHub/CircleCI API where configured. `App.tsx` — trigger async after any write/edit turn.
**Why:** Fully non-blocking means there's no UX cost regardless of how long verification takes. A type-check taps you on the shoulder in 3 seconds; a CI run taps you on the shoulder in 8 minutes. Same model, same UX, any duration.

## 9. Prompt caching across all providers
**What:** Enable caching on the stable system prefix (base prompt + repo map + retrieved files) for every provider that supports it:
- **Anthropic**: add `cache_control: { type: "ephemeral" }` breakpoints after the system prompt and after retrieved files in `agent/run.ts`. Requires explicit opt-in. ~90% discount on cached tokens.
- **OpenAI + DeepSeek**: fully automatic for prompts >1024 tokens — no code changes needed, but `context/builder.ts` must put stable content first (it already does). Track savings from `usage.prompt_tokens_details.cached_tokens` in the response.
- **Gemini 2.5+**: implicit caching is on by default. For long stable contexts, use explicit `caches.create()` via the Gemini SDK for more control and a named cache.
**Where:** `context/builder.ts` — verify assembly order is stable-prefix-first for all providers. `agent/run.ts` — add Anthropic breakpoints + Gemini explicit cache creation. `accounts/usage.ts` — track `cachedTokens` separately and surface in `/cost` as "saved $Y from caching."
**Why:** Routing saves money by picking cheaper models. Caching saves money on whatever model you pick. Combined they multiply. OpenAI and DeepSeek work with zero API changes — just confirming the prefix is stable is most of the work.

## 10. Persistent shell session across tool calls
**What:** Right now each `run_shell` starts a fresh shell — `cd` doesn't persist, env vars set in one call vanish in the next. Keep a single shell process alive for the session. `cd`, `export`, `source` all stick.
**Where:** `src/shell.ts` — replace the stateless `execFile` approach with a long-running shell process, write commands to its stdin, read output from stdout.
**Why:** A huge source of agent errors today. The agent `cd`s into a directory, runs a command in a new shell that starts at the project root, and gets confused. This is why agents write `cd foo && npm test` as a single command — they're working around stateless shells. Fix the root cause.

## 11. Git context in the system prompt
**What:** Include the current git branch, last 5 commit messages, and the current `git diff --stat` (files changed, not the full diff) in the system prompt. Costs very few tokens, massively helps the model understand what's in progress.
**Where:** `context/builder.ts` — add a `gitContext()` section alongside `repoMap()`. Read from `git log --oneline -5` and `git diff --stat`.
**Why:** The model currently has no idea whether it's on main or a feature branch, whether there are uncommitted changes, or what work happened recently. This context prevents it from working against in-progress changes.

## 12. Web search tool
**What:** Add a `web_search(query)` tool the model can call when it needs to look up docs, error messages, or library APIs it doesn't know. Use a free/cheap search API (Brave, SearXNG, or even just fetching a URL).
**Where:** `src/tools.ts` — new tool alongside read/write/edit/shell. Available in all modes except plan.
**Why:** Every competing tool has this. It's the difference between the agent hallucinating a library's API vs looking it up. Especially important when routing to cheaper models that have weaker knowledge of recent libraries.

## 13. MCP server connections
**What:** Let users connect their own MCP servers (databases, APIs, internal tools) via config. The model gets access to those tools alongside the built-in ones. Config in GEARBOX.md or a `~/.gearbox/mcp.json`.
**Where:** `src/tools.ts` — load and register MCP tools at startup. `cli.tsx` — read MCP config.
**Why:** Claude Code and Codex both support this. It's how developers plug in their own Postgres, Stripe, GitHub, Linear, etc. Without it Gearbox is limited to files and shell. With it, you can run `fix the failing payment in production` and it actually has the tools to do it.

## 14. Image / screenshot input
**What:** Let users paste or drag an image (screenshot, design spec, error dialog) into the composer and include it in the model message. Supported by all major providers via vision APIs.
**Where:** `src/ui/components/Composer.tsx` — handle paste events with image data. `src/agent/run.ts` — include image content parts in the message.
**Why:** Common workflow: screenshot a UI bug or a design mockup, paste it, ask the agent to match it. Codex has this. Without it, users have to describe images in words, which is slow and lossy.

## 15. `/init` actually generates a useful GEARBOX.md
**What:** The `/init` command is listed but probably generates a generic file. Make it actually useful: scan the repo (file structure, package.json/pyproject.toml, existing test commands, README), and write a GEARBOX.md that tells the agent the project's stack, how to run tests, key architectural decisions, and files to always include.
**Where:** `App.tsx` command handler for `/init` — run a one-shot agent call with a prompt that reads the repo and produces structured project context.
**Why:** The first thing a new user does is `/init`. If it generates something generic, they lose trust immediately. If it generates something accurate and useful, the agent immediately understands their project better — which is the whole onboarding moment.

---

## 16. Subagent delegation for bounded tasks
**What:** When the main agent needs to do a clearly bounded sub-task — summarize a large file, search the codebase for a symbol, classify a test failure — spin up a one-shot call to the cheapest model that clears the bar for that sub-task, run it in an isolated context, and return the result to the main thread. The main model stays warm and never sees the cheap model's raw context. Show in the transcript: `↳ haiku · summarize auth.ts · $0.0004`.
**Where:** New `src/agent/subtask.ts` — `runSubtask(prompt, kind)` calls `RoutingSelector` with the sub-task kind, runs a single streamText call, returns the result as a string. `tools.ts` — wrap read_file summarization and large search results through this.
**Why:** This is the "fine-grained savings" from DESIGN.md — not switching the main model mid-conversation (loses cache), but delegating grunt work to cheap models in isolated contexts. A large file summary costs $0.0004 on haiku instead of $0.012 on sonnet. The user sees nothing different; the cost ledger does.

## 17. URL / webpage as context
**What:** If the user pastes a URL into the composer (or uses `/fetch <url>`), Gearbox fetches the page, strips it to readable text, and includes it in the message context. Show it as `[fetched: docs.stripe.com/api]` in the transcript.
**Where:** `App.tsx` — detect URL pattern on submit, fetch + parse before building the message. New `src/ui/fetch.ts` — fetch URL, strip HTML to text.
**Why:** The most common workflow that currently fails: "implement this following these docs" with a link the model can't see. Forces users to paste docs manually. Aider and Codex both support this.

## 18. `/review` — code review mode
**What:** `/review` (or `/review staged`) reads the current `git diff` or staged changes and gives structured feedback: confirmed bugs, potential issues, style notes. Output is a numbered list, not prose. Uses the router to pick a strong model. Read-only — never edits files.
**Where:** `App.tsx` command handler — run `git diff` or `git diff --staged`, pass to `runTask` in plan mode with a review-specific system prompt.
**Why:** Natural pre-commit workflow that doesn't require an IDE. Reinforces Gearbox as a git-native tool.

## 19. Watch mode
**What:** `gearbox --watch` (or `/watch on`) monitors the working directory for file saves. When a saved file contains a `// GEARBOX: <instruction>` or `# gearbox: <instruction>` marker, Gearbox picks it up, handles the instruction, removes the marker, and commits. Developer stays in their editor; Gearbox runs in a terminal pane. Because routing is live, a simple "fix this type error" marker gets routed to haiku automatically — cheap, invisible, fast.
**Where:** New `src/watch.ts` — Bun's native file watcher (`Bun.watch`), scan saved files for the marker pattern, dispatch as a new turn. `cli.tsx` — `--watch` flag activates it.
**Why:** Removes the context-switch back to the terminal entirely. Particularly powerful with routing — small fix-this markers are cheap tasks, Gearbox routes them to the cheapest model without you thinking about it.

## 20. Inline model override per prompt
**What:** Prefix any prompt with `@haiku`, `@sonnet`, `@opus`, or `@deepseek` to force that model for just that one turn. Routing continues normally on the next turn.
**Where:** `App.tsx` — parse `@<modelname>` at the start of the submitted prompt, pass as a `FixedSelector` override for that single turn only.
**Why:** Routing is right 80% of the time. The other 20%, users need a fast escape hatch without touching settings.

## 21. Session budget cap with amber warning
**What:** `/budget $5` sets a hard cap for the session. Status bar goes amber at 80%, pauses and asks at 100%. Per-session and per-day caps both supported.
**Where:** `App.tsx` — track cumulative cost against cap after each turn. `StatusBar.tsx` — amber cost color when >80%. `accounts/usage.ts` — persist daily totals.
**Why:** Removes the "what if I come back to a $50 bill" fear. Directly enables unattended long tasks.

## 22. `/retry @model` — retry with a different model
**What:** `/retry` resends the last prompt. `/retry @haiku` resends it with a specific model override. Previous response replaced in transcript.
**Where:** `App.tsx` — extend existing `/retry` handler to accept an optional `@model` argument.
**Why:** Makes routing feel controllable. If routing picked haiku and it wasn't good enough, one command tries sonnet on the same prompt without retyping.

## 23. Persistent shell across tool calls
**What:** Keep a single shell process alive for the session. `cd`, `export`, `source` all stick between `run_shell` calls.
**Where:** `src/shell.ts` — replace stateless `execFile` with a long-running shell process, write to stdin, read from stdout with a sentinel to detect completion.
**Why:** The current stateless shell is why agents write `cd foo && npm test` as one string. Fixing this eliminates a whole class of errors silently.

## 24. `/summary` — session handoff doc
**What:** Generate a compact summary of the session: what was accomplished, what files changed, what's in progress, what's next. Output in transcript, optionally append to GEARBOX.md.
**Where:** `App.tsx` command handler — one-shot summarization call routed to a cheap model.
**Why:** Long sessions suffer from context drift. `/summary` creates a durable record before closing or continuing tomorrow.

## 26. `/undo` — revert the last turn completely
**What:** Undoes the last turn: reverts file changes via `git reset`, AND removes that turn from the conversation history so the model doesn't reference something that no longer exists. `/undo 3` goes back 3 turns.
**Where:** `App.tsx` — pop the last N turns from `msgRef` and `itemsRef`, run `git reset HEAD~1` or `git checkout` for each file touched in those turns.
**Why:** `git revert` only fixes the files. Without removing the turn from history, the model still thinks it made those changes and builds on them. True undo requires both.

## 27. Context pinning (`@pin auth.ts`)
**What:** `@pin auth.ts` keeps a file permanently in context for the session regardless of BM25 retrieval scores. Pinned files always appear in the system prompt. `/pins` lists them; `@unpin auth.ts` removes one.
**Where:** `App.tsx` — maintain a `pinnedFiles` set in session state. `context/builder.ts` — inject pinned files into the system prompt before retrieved files, outside the retrieval budget.
**Why:** BM25 retrieval decides context per-turn. Files that are always relevant (schema, config, auth) may not score highly for every prompt and get dropped. Pinning removes that uncertainty for files you know matter.

## 28. Cost estimate before sending
**What:** While the user is typing, show a dim cost estimate in the composer for what the turn will cost based on current context size × routed model price. Updates as the prompt grows. Example: `~$0.02` when context is large, nothing when it's small.
**Where:** `Composer.tsx` — compute `countTokens(prompt) + sessionContextTokens` × `costOf(currentModel)` on each keystroke, display when above a threshold.
**Why:** Makes expensive turns visible before they happen. Particularly useful when context is nearly full and the estimate spikes — the user can `/compact` first.

## 29. Provider health check on startup
**What:** On launch (and via `/status`), probe each configured provider with a lightweight request and show latency: `anthropic ✓ 340ms · deepseek ✓ 180ms · openai ✗ timeout`. The router uses this to deprioritize unreachable providers before a turn fails.
**Where:** `accounts/detect.ts` — async health probes on startup. `model/router.ts` — filter candidates by reachability before scoring. `StatusBar.tsx` — show ✗ next to provider name when it fails.
**Why:** Right now routing picks a provider and fails silently on a timeout. Probing on startup means the router knows before it picks, not after.

## 30. Steer mid-response
**What:** Press `s` while the model is streaming to open a small inline input. Type a correction ("don't touch auth.ts", "use TypeScript not JavaScript") and it's injected as a system nudge — the model receives it and adjusts direction without stopping and restarting the whole turn.
**Where:** `App.tsx` — detect `s` keypress during streaming state, render a mini composer overlay, append the correction to the in-flight message stream via the AI SDK's `experimental_appendMessage` or equivalent.
**Why:** Right now the only option mid-stream is full interrupt (esc) and retype everything. Steering is more like tapping a colleague on the shoulder than making them start over.

## 25. Ollama / local model support
**What:** Add Ollama as a provider (OpenAI-compat at `localhost:11434`). Auto-detect on startup, use as the $0/token tier for cheap sub-tasks. Route summarize/classify/search tasks to it when available.
**Where:** `providers.ts` — Ollama entries via openai-compat. `accounts/detect.ts` — probe localhost on startup. `model/profiles.ts` — profiles for common Ollama models.
**Why:** $0/token is an unbeatable routing tier. Users who already run Ollama get it for free. Also makes Gearbox usable with no API keys.

---

# Context & Memory

## C1. Multi-scope persistent memory
**What:** Facts tagged by scope: project (saved to GEARBOX.md, applies to this repo), user (saved to `~/.gearbox/memory.json`, applies across all repos), session (current conversation only). Each scope injected at the right level automatically. Right now memory is a single flat file.
**Where:** `context/memory.ts` — split into three stores with separate read/write paths. `context/builder.ts` — inject user memory first, then project memory, then session facts.
**Why:** A user preference ("always use TypeScript strict mode") shouldn't have to be re-stated per project. A project decision ("we use Postgres") shouldn't leak into other repos.

## C2. Auto-extract facts during conversation
**What:** After each assistant response, scan for statements that look like decisions or facts ("I'll use PostgreSQL", "the auth system uses JWT", "tests live in __tests__/"). Extract them and silently save to project memory. Surface a dim line: `· saved: "auth uses JWT"`. User can undo with `/memory undo`.
**Where:** New lightweight extraction pass in `App.tsx` after each turn — a cheap regex + keyword classifier, or a haiku call for ambiguous cases. Write to `context/memory.ts`.
**Why:** Users shouldn't have to manually `/memory` everything important. The agent already says what it's doing — capture it automatically.

## C3. Semantic memory search
**What:** Instead of injecting all memory every turn, rank saved facts by relevance to the current prompt (BM25, same approach as file retrieval). Only inject the top-K most relevant facts. Keeps context lean on projects with large memory stores.
**Where:** `context/memory.ts` — index facts the same way `context/retrieve.ts` indexes files. `context/builder.ts` — replace full memory dump with `retrieveFacts(userText, budget)`.
**Why:** A project with 6 months of memory would otherwise flood the context with irrelevant facts. Retrieval keeps it targeted.

## C4. Memory conflict detection
**What:** Before saving a new fact, check if it contradicts an existing one ("use Postgres" vs saved "use SQLite"). If conflict detected, surface it in the transcript: `⚠ conflict: saved "SQLite" vs new "Postgres" — which is current?` and let the user resolve before saving.
**Where:** `context/memory.ts` `appendFact()` — run a similarity check against existing facts before writing.
**Why:** Silent overwrites corrupt memory over time. One wrong fact that gets saved and re-injected every session is hard to debug.

## C5. Cross-session context restore
**What:** On session start, auto-inject a one-paragraph summary of recent sessions on this project: what was accomplished, what's in progress, what was left to do. Generated from the last session's `/summary` output or from the session's item list.
**Where:** `context/builder.ts` — check for a `~/.gearbox/sessions/<slug>/last-summary.md` and inject it as a memory section. `session.ts` — write the summary on session close.
**Why:** Starting a session cold on a project you worked on yesterday forces you to re-explain everything. This makes continuity the default.

## C6. Entity tracking
**What:** Automatically track named entities mentioned in the session — function names, file paths, error codes, variable names, branch names — and make them searchable within the session. When you say "fix the bug in `handleRefresh`", the entity tracker knows that's in `auth.ts` from when it was mentioned 10 turns ago.
**Where:** New `context/entities.ts` — lightweight pass after each turn, extract code-shaped tokens (camelCase, file paths, error strings). Store in session state. `context/builder.ts` — inject entities relevant to current prompt.
**Why:** Models forget what was mentioned earlier in long sessions. Entity tracking is a lightweight substitute for full episodic memory.

## C7. Decision-preserving compaction
**What:** `/compact` currently summarizes everything uniformly. Smart compaction first identifies explicit decisions and conclusions ("we decided to X because Y", "DO NOT modify Z") and locks them in verbatim before compressing the rest. Decisions survive compaction; routine tool calls don't.
**Where:** `context/compact.ts` — pre-pass to extract decision sentences before summarization. Inject extracted decisions as a separate pinned section after compaction.
**Why:** The most painful thing about context compression is losing architectural decisions that were established early. Everything else can be summarized; decisions cannot.

## C8. Memory editing
**What:** `/memory edit` opens an interactive list of saved facts with the ability to delete, correct, or promote/demote scope. Shows when each fact was saved and where (which session, which turn).
**Where:** `App.tsx` command handler — render facts as a navigable list in the transcript. Arrow keys + enter to edit, `d` to delete.
**Why:** Auto-extraction (C2) will sometimes save wrong facts. Without a way to correct them, errors compound over time.

## C9. File change log
**What:** Track which files were changed in which sessions, with a one-line description of what changed: "auth.ts · added JWT refresh · session 4 · June 4". Shown in `/context` and injected as a compact section at session start.
**Where:** `session.ts` — after each turn that writes/edits files, append an entry to `~/.gearbox/sessions/<slug>/changelog.json`. `context/builder.ts` — inject recent changelog entries.
**Why:** When you return to a project after a week, the biggest question is "what did the agent touch and when." This answers it in two seconds.

## C10. CLAUDE.md / AGENTS.md import
**What:** On startup, automatically read any existing `CLAUDE.md`, `AGENTS.md`, or `.cursorrules` in the project root as project memory, alongside GEARBOX.md. No manual setup needed for repos already using Claude Code or Cursor.
**Where:** `context/memory.ts` `loadProjectMemory()` — extend the file list to include these filenames.
**Why:** Gearbox should work seamlessly in repos that already have project instructions for other tools. Most repos developers want to use Gearbox on already have one of these files.

---

# Routing

## R1. Task complexity estimation
**What:** Before routing, estimate actual difficulty beyond verb detection. Signals: number of files likely touched (from BM25 retrieval scores), whether the task is cross-cutting (touches multiple modules), estimated token output (long response = complex task). A prompt saying "clean up the imports" routes cheap even though "clean up" is an edit verb.
**Where:** `model/router.ts` `classify()` — add a complexity score (0–1) that scales the quality bar up. High complexity → raise the bar → stronger model required.
**Why:** The current classifier is verb-based and crude. Real task difficulty is about scope, not just the action word.

## R2. Latency-class routing
**What:** Distinguish "I'm waiting for this" (interactive) from "run in the background" (async). Interactive tasks get the fastest model that clears the quality bar; background tasks ignore latency and get the best model. User sets this with `@background` prefix or via the background queue (S4).
**Where:** `model/selector.ts` — add `latencyClass: "interactive" | "background"` to `Task`. `model/router.ts` — sort candidates by `tps` descending for interactive, by `qualityOf` descending for background.
**Why:** When you're waiting, speed matters more than the marginal quality difference between sonnet and opus. When you're asleep, it doesn't.

## R3. Credit-scarcity scoring
**What:** When a provider's credit balance is low or its rate-limit headroom is shrinking, add a penalty to its routing score. Preserve the scarce account for tasks only it can do well; route general tasks elsewhere.
**Where:** `model/router.ts` `score()` — read `accountUsage(id).balance` and `rates` from `usage.ts`. Add `w_scarcity × (1 - balance/total)` to the score.
**Why:** The data structures already exist. The router just doesn't read them. Without this, the router drains the account that happens to score best and ignores the full one.

## R4. Subscription-first routing
**What:** If the user has a Claude Max or ChatGPT Pro flat-rate seat, route to it first — marginal cost is ~$0 until rate limits hit. Only fall back to metered API when the seat is rate-limited. Surface this in the routing reason: "Claude · subscription seat · ~$0."
**Where:** `model/router.ts` — check account `exec === "cli"` and current rate utilization. Score CLI-backed accounts with a large plan bonus when headroom > 20%.
**Why:** "Use what you're already paying for" is the clearest possible cost saving and requires no AI at all — just routing logic.

## R5. Per-repo quality priors from git
**What:** After each session, check git log for the agent's commits. If a commit was later reverted (by the user), log it as a negative signal for the model that made it. If kept and built upon, log positive. Adjust per-repo quality scores over time. After 20+ data points, the router knows haiku is fine for this Python codebase.
**Where:** New `model/calibration.ts` — scan `git log` for Gearbox-authored commits + subsequent reverts. Update `~/.gearbox/repo-priors/<slug>.json`. `model/router.ts` — blend repo priors with seeded benchmarks, weighted by confidence (sample count).
**Why:** Benchmark quality scores are population averages. Your codebase isn't average. Per-repo learning is the flywheel that makes routing actually good over time.

## R6. Model knowledge cutoff awareness
**What:** Track each model's training cutoff date in `profiles.ts`. When a task involves a recently-released library (detected from the prompt or from package.json dependencies), deprioritize models whose cutoff predates that library's release. Route to models with web search capability or fresher training instead.
**Where:** `model/profiles.ts` — add `knowledgeCutoff: string` per model. `model/router.ts` — detect recency signals in prompt + package versions, apply cutoff penalty.
**Why:** Routing a "how do I use Next.js 16" task to a model trained before Next.js 16 exists produces hallucinated APIs. Cutoff awareness prevents this class of error.

## R7. Confidence-gated routing
**What:** The classifier assigns a confidence to its task-kind output. When confidence is low (ambiguous prompt), route conservatively — use a stronger model than the bare quality bar requires. Log the uncertainty. Only route aggressively cheap when confidence is high.
**Where:** `model/router.ts` `classify()` — return `{ kind, confidence: 0..1 }`. `score()` — multiply quality bar by `1 + (1 - confidence) × 0.2` when uncertain.
**Why:** A wrong classification that sends a hard task to a cheap model is worse than an over-cautious classification that uses a slightly stronger model. Asymmetric cost — always err toward quality when unsure.

## R8. Override feedback loop
**What:** When a user does `/retry @sonnet` after routing picked haiku, or `/prefer code sonnet`, log it as a signal that haiku underperformed on that task type in this repo. Feed into R5's calibration. Over time, routing learns from corrections without requiring explicit feedback.
**Where:** `model/preferences.ts` `confirmRoutingPreference()` — already exists. `model/calibration.ts` (R5) — treat overrides as negative signals for the originally-picked model.
**Why:** Users correct routing by natural behavior (retrying with a better model). That behavior is already happening; it just isn't being captured.

## R9. Per-task-kind cost ceiling
**What:** Config in GEARBOX.md or `~/.gearbox/config.toml`: `[routing.ceilings] search = 0.01, summarize = 0.005, code = 0.10`. The router enforces these as hard caps — if the cheapest model clearing the quality bar would exceed the ceiling, it halts and asks rather than exceeding it silently.
**Where:** `model/router.ts` — after selecting candidate, check `costOf(model) × estTokens` against the configured ceiling for that kind. Emit a `permission` event if ceiling would be exceeded.
**Why:** Prevents a miscategorized or unexpectedly large task from blowing the budget on what should have been a cheap operation.

---

# Subagents & Workflows

**Note on all S features:** Gearbox uses these patterns autonomously when it determines they're the right approach — the user doesn't need to know the terminology. When a task is clearly parallelizable, Gearbox fans it out. When a task is large and risky, it uses a worktree. When cost or time implications are significant, it asks first with a plain-English prompt: "this will run 4 parallel tasks (~$0.08 total, ~2 min) — proceed?" The user approves or declines; the orchestration is invisible.

## S1. Parallel subagents with worktree isolation
**What:** When Gearbox determines a task has multiple independent parts (detected from the prompt structure, file scope, or explicit list), it automatically splits into parallel subagents each running in their own git worktree. File edits never conflict. Main agent coordinates, subagents work simultaneously, results get merged. Gearbox surfaces: "splitting into 3 parallel tasks · ~$0.06 · ~90s — proceed?" before starting.
**Where:** New `src/agent/orchestrator.ts` — task decomposition, worktree creation (`git worktree add`), parallel `runTask` calls, result merging + cleanup. `App.tsx` — permission prompt before launch.
**Why:** The single biggest speed improvement available for large tasks. A task that takes 6 minutes sequentially takes 2 minutes in parallel. Users don't need to know about worktrees — Gearbox just makes the work faster.

## S2. Fan-out for uniform tasks
**What:** When a task applies the same operation to multiple units ("add tests for every function", "add JSDoc to all exported functions", "translate all error messages"), Gearbox automatically detects the pattern, decomposes into N parallel sub-tasks, runs them simultaneously in isolated worktrees, and merges. Asks before starting when N > 3 or estimated cost > $0.05.
**Where:** `src/agent/orchestrator.ts` — fan-out decomposer: detect list-shaped tasks, enumerate units (via code analysis or the model), dispatch in parallel.
**Why:** The user said "add tests for every function" — they didn't say "run 12 parallel agents." Gearbox figures out that's the right execution and does it. The user gets the result faster without knowing how.

## S3. Pipeline workflows
**What:** Gearbox automatically chains dependent steps when a task has a natural sequence: lint → fix → test → fix → commit. Each step's output feeds the next step's context. Detects the pipeline structure from the task description or from verification results (tests fail → automatically feeds failures to the next fix step). Named pipelines definable in GEARBOX.md for repeated workflows like `deploy` or `release`.
**Where:** `src/agent/orchestrator.ts` — pipeline runner: step queue, output threading, step-level routing (different model per step type). `context/memory.ts` — load named pipelines from GEARBOX.md.
**Why:** Workflows like "fix all lint errors then run tests then fix failures" are repetitive to set up manually. Gearbox should recognise them and run them end-to-end.

## S4. Background task queue
**What:** `gearbox --queue "fix all TODOs"` or `/queue <task>` submits a task that runs in the background. Gearbox keeps working after you close the session, sends a desktop notification when done, and results are waiting when you return. Multiple queued tasks run sequentially (or in parallel if independent). Queue state persists across restarts.
**Where:** New `src/queue.ts` — persistent queue in `~/.gearbox/queue.json`, background Bun subprocess per task, notification via `terminal.ts` `notify()`.
**Why:** Long tasks shouldn't require you to watch a terminal. Submit and walk away; get tapped when it's done.

## S5. Independent reviewer subagent
**What:** After the main agent makes changes, Gearbox automatically spins up a separate reviewer subagent (routed to a model appropriate for code review) to critique the diff before committing. The reviewer sees only the diff — not the main agent's reasoning or conversation — so it gives a genuinely independent opinion. Surfaces: "reviewer found 2 issues" with the option to fix before committing. Triggered automatically on large diffs or explicitly via `/review`.
**Where:** `src/agent/orchestrator.ts` — post-edit reviewer: run `git diff`, pass to a separate `runTask` call with a review prompt. `App.tsx` — surface reviewer findings as a structured list.
**Why:** The main agent is biased toward its own output. An independent reviewer with no context about why the changes were made catches different errors — exactly what a human code review does.

## S6. Supervisor pattern for large tasks
**What:** For large, complex tasks ("refactor the entire auth system", "migrate from REST to GraphQL"), Gearbox automatically uses a supervisor pattern: a strong model breaks the task into a structured plan of sub-tasks, delegates each to appropriately-routed agents, reviews their outputs, and synthesizes. The user sees a clean progress view, not the internal delegation. Gearbox asks before starting: "this is a large task — I'll coordinate 5 sub-tasks (~$0.40 total). Proceed?"
**Where:** `src/agent/orchestrator.ts` — supervisor mode: planning call → sub-task list → parallel/sequential dispatch → synthesis call. Task size detected from estimated scope (files touched, complexity score from R1).
**Why:** Large tasks fail when a single agent tries to hold everything in one context. The supervisor pattern keeps each sub-task small, focused, and verifiable while the user sees only the top-level result.

## S7. Worktree-based feature branches
**What:** For any task that creates new functionality or makes significant changes, Gearbox automatically creates a git worktree on a new branch, does all the work there, and presents a diff for approval before offering to merge. Nothing touches the current branch until explicitly approved. The branch name is auto-generated from the task description.
**Where:** `src/agent/orchestrator.ts` — detect "significant change" tasks (new feature, large refactor), run `git worktree add -b <branch>`, execute there, run `git diff main`, present for approval.
**Why:** The biggest fear of agent coding is "what if it breaks something on main." Worktree isolation makes that impossible by default — the agent literally cannot touch your working branch until you approve.

## S8. Workflow templates
**What:** Named, reusable workflows defined in GEARBOX.md: `[workflow.deploy]: lint → test → build → push`. Running `gearbox --workflow deploy` or `/workflow deploy` executes the sequence with routing picking the appropriate model per step type. Common workflows (test, release, review) have sensible defaults if not configured.
**Where:** `context/memory.ts` — parse `[workflow.*]` sections from GEARBOX.md. New `src/agent/orchestrator.ts` workflow runner.
**Why:** Repetitive multi-step processes shouldn't require re-typing every time. Define once, run forever. Also makes Gearbox's behavior on a project predictable and documentable.

## S9. Scratchpad agents
**What:** "Try rewriting auth with Passport.js and show me the diff" — Gearbox creates a throwaway worktree, makes the changes there, shows the diff, and waits. If you like it, apply it. If not, discard with no trace. Automatically used when the task contains exploratory language ("try", "experiment with", "what would X look like").
**Where:** `src/agent/orchestrator.ts` — scratchpad mode: `git worktree add --detach`, run task, `git diff`, present. Keep worktree until user decides; clean up on decision.
**Why:** Exploration currently requires courage — the agent might touch real files. Scratchpad removes the risk entirely, making it safe to ask "what if" questions.

## S10. Speculative pre-execution
**What:** While the user is reading a response, Gearbox analyzes the conversation to predict the most likely next prompt (e.g., after "here's my plan" → likely "go ahead and implement it"). Starts that task speculatively in a scratchpad. If the user's actual next message matches, the result is already done or half-done. If not, the scratchpad is discarded silently. Only runs when confidence in the prediction is high and cost is low (cheap model for prediction).
**Where:** `App.tsx` — after each assistant response, run a cheap prediction call; if confidence > 0.8 and estimated cost < $0.02, start speculatively in a background scratchpad. Cancel on mismatch.
**Why:** The biggest latency in an agent loop is the gap between reading a response and getting the next result. Speculative execution collapses that gap for predictable workflows.
