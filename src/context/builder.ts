/**
 * Context Engine: `buildContext`
 *
 * This module is the single place where every per-turn model request is
 * assembled. Its job is to project the full conversation history (the
 * append-only ledger kept in App's msgRef) into a bounded, model-aware
 * working set that fits within the target model's context window.
 *
 * Why curate at all? Experiments (experiments/context/FINDINGS.md) showed
 * that a curated context is ~16x cheaper per turn than dumping the raw
 * transcript, stays bounded instead of overflowing, and produces the same
 * correct edits. Curation is also what enables model routing: a switched
 * model gets a small, clean context, not the entire raw history.
 *
 * Assembly order (stable cacheable prefix first, volatile per-turn tail last):
 *
 *   system   = base prompt + plan addendum + verification commands
 *              + project memory + repo map
 *              All of these are session-stable, so they form a
 *              byte-identical cached prefix that Anthropic's prompt cache
 *              can reuse across turns at ~0 recurring cost.
 *
 *   messages = curated history (whole turns only) + a single user message
 *              that FOLDS IN the volatile context: git state and freshly
 *              retrieved files for THIS prompt. The cache breakpoint sits at
 *              the end of the settled history, so the volatile tail rides
 *              after the breakpoint and never busts the cached prefix. In an
 *              earlier design this volatile content lived in `system`, which
 *              broke the prompt cache on every turn.
 *
 * THE INVARIANT: never split a tool_use from its tool_result. Curation and
 * trimming always operate at whole-turn boundaries. Eliding an old turn drops
 * BOTH the assistant's tool-call parts AND the paired tool-result messages
 * together, so the messages array always contains balanced tool ids.
 */
import type { ModelMessage } from "ai";
import type { ModelSpec } from "../providers.ts";
import { countTokens } from "../model/tokens.ts";
import { loadProjectMemory } from "./memory.ts";
import { repoMap } from "./repomap.ts";
import { retrieveFiles } from "./retrieve.ts";
import { gitContext } from "./git.ts";
import { detectVerificationCommands } from "../verify.ts";

export const BASE_SYSTEM = `You are Gearbox, a precise terminal coding agent.
Work in small, verifiable steps. Use the tools to read before you write, and
run tests or commands to check your work rather than assuming. Prefer the
smallest change that solves the problem. Be concise in prose; let the diffs and
test output speak. When done, say briefly what you changed and how you verified it.
Style: no em dashes (—); use a comma, a period, or " · " instead. When you state a
count (lines, files, changes), make it match the actual diff exactly.
If the user asks something unrelated to code or this repository (a general
question, a definition, anything), just answer it directly and concisely —
never refuse, never redirect to the repo, and never reinterpret it as a
question about this codebase.
Delegation — actively look for it, don't wait to be asked. When a request splits
into INDEPENDENT pieces (the same kind of change across several files/modules, or
several unrelated changes), decompose it yourself and fan it out with
\`delegate_parallel\`: each piece runs at once on its own best-routed model in an
isolated worktree, then they're merged back. A good signal: you're about to do the
same thing to 3+ files, or the user asked for several separable things. For a single
sizable piece (a focused refactor, bulk edits, research, generation), use
\`delegate\`. Each sub-task must be SELF-CONTAINED — the sub-agent can't see this
conversation, so spell out the goal, files, and definition of done. Do small or
tightly-coupled work yourself; delegate the independent chunks. After the tools
return, verify the merged result and report what changed.

Memory — when you learn a durable, non-obvious fact about THIS project (a build
quirk, a vendor gotcha, a stated constraint, a decision and its why), save it with
the \`remember\` tool the moment you learn it. Sparingly: one short sentence, only
things a future session would otherwise rediscover the hard way.

Efficiency and restraint (these save the user's tokens and time):
- After edit_file or write_file succeeds, the change is applied; a failed edit
  throws. Do NOT re-read a file just to confirm an edit landed, and do not reprint
  a file you just wrote (reference its path).
- For an existing file, prefer edit_file (a targeted diff) over write_file; reserve
  write_file for a new file or a full rewrite.
- When independent read-only lookups (read_file, search, glob, list_dir) don't
  depend on each other, issue them in ONE step, not one at a time.
- Make the smallest change that solves the task. Don't add features, refactor, or
  introduce abstractions beyond what was asked; prefer a small local fix over a
  cross-file change, and reuse patterns and libraries already in the repo.
- Default to no comments; add one only where the WHY is non-obvious. Don't create
  *.md or README files unless asked. Prefer editing an existing file to a new one.
- The RELEVANT FILES block already holds the top matches for the task; act on it
  and widen the search only on a concrete miss, rather than re-reading broadly.
- Act directly on simple tasks; don't narrate a plan you're about to execute, and
  don't end a turn with only a plan unless asked (plan mode excepted). The
  deliverable is the diff.`;

export const PLAN_ADDENDUM = `

# PLAN MODE (read-only)
You are in read-only plan mode. Investigate using read-only tools only, then
produce a concise, numbered plan for the change. DO NOT modify files or run
commands. End by noting you're ready to implement once the user approves.`;

// Tokens held back from the context window budget for the model's own output
// plus a safety margin. The remainder is the input budget for system + history.
const OUTPUT_RESERVE = 32_000;

// Number of most-recent turns kept verbatim (with full tool call/result pairs).
// Older turns are elided: assistant text is kept but tool exchanges are stripped.
const RECENT_TURNS = 3;

// Rough overhead per message for role field and JSON/HTTP framing tokens.
const PER_MESSAGE_OVERHEAD = 4;

export interface ContextSection {
  name: string;
  tokens: number;
}

export interface BuiltContext {
  system: string;
  messages: ModelMessage[];
  sections: ContextSection[];
  // Index of the last SETTLED-history message, i.e. where the cacheable prefix
  // ends. The per-turn volatile context (git + retrieved files) rides in the
  // final user message AFTER this index, so the stable system + growing history
  // remain a byte-identical cacheable prefix across turns. Set to -1 when there
  // is no settled history yet (first turn), meaning only the system block caches.
  cacheBreak: number;
}

// ── token helpers ──────────────────────────────────────────────────────────────

/**
 * Flatten a ModelMessage content value to a plain string for token counting.
 * Handles all content shapes: plain string, part arrays (text, image, tool-call,
 * tool-result), and arbitrary JSON as a fallback.
 */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => {
        if (typeof p === "string") return p;
        if (p?.type === "text") return p.text ?? "";
        if (p?.type === "image") return `[image ${p.mediaType ?? ""}]`;
        if (p?.type === "tool-call") return JSON.stringify(p.input ?? p.args ?? {});
        if (p?.type === "tool-result") return typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? p.result ?? "");
        return JSON.stringify(p ?? "");
      })
      .join(" ");
  }
  return JSON.stringify(content ?? "");
}

/** Estimated token cost of a single ModelMessage, including per-message framing. */
export function msgTokens(m: ModelMessage, modelId?: string): number {
  return countTokens(textOf((m as any).content), modelId) + PER_MESSAGE_OVERHEAD;
}

// ── turn grouping and elision (the invariant lives here) ──────────────────────

/**
 * Group a flat message array into turns. A turn starts with a user message and
 * includes the following assistant + tool messages up to (but not including) the
 * next user message. This is the unit of granularity for elision and trimming,
 * ensuring tool_use/tool_result pairs are never split across group boundaries.
 */
export function groupTurns(history: ModelMessage[]): ModelMessage[][] {
  const turns: ModelMessage[][] = [];
  for (const m of history) {
    if (m.role === "user" || turns.length === 0) turns.push([m]);
    else turns[turns.length - 1]!.push(m);
  }
  return turns;
}

/**
 * Elide an old turn to save tokens while preserving context continuity.
 * Keeps the user message and any assistant prose (text parts), but drops all
 * tool-call parts from assistant messages and the corresponding tool-result
 * messages entirely. Dropping both sides together maintains balanced tool ids.
 * An assistant message that consisted solely of tool-calls is dropped outright.
 */
function elideTurn(turn: ModelMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of turn) {
    if (m.role === "tool") continue; // drop tool results (paired call also stripped below)
    if (m.role === "assistant" && Array.isArray((m as any).content)) {
      // Keep only plain text parts; strip tool-call parts.
      const kept = (m as any).content.filter((p: any) => typeof p === "string" || p?.type === "text");
      if (kept.length) out.push({ ...(m as any), content: kept } as ModelMessage);
      // If the assistant message was purely tool-calls, it is dropped entirely.
    } else {
      out.push(m);
    }
  }
  return out;
}

/**
 * Drop any tool-call that has no matching tool-result and any tool-result with
 * no matching tool-call, so the message array is always valid to send (every
 * tool_use paired with a tool_result). Needed because an INTERRUPTED turn can
 * leave a trailing assistant tool_use whose result never arrived; without this
 * the next request 400s. Idempotent: a balanced array passes through unchanged.
 */
export function sanitizeToolPairs(messages: ModelMessage[]): ModelMessage[] {
  // First pass: collect all call ids and result ids present in the array.
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const m of messages) {
    const c = (m as any).content;
    if (!Array.isArray(c)) continue;
    for (const p of c) {
      if (p?.type === "tool-call") callIds.add(p.toolCallId);
      if (p?.type === "tool-result") resultIds.add(p.toolCallId);
    }
  }
  // Second pass: retain only parts whose partner exists in the other set.
  const out: ModelMessage[] = [];
  for (const m of messages) {
    const c = (m as any).content;
    if (!Array.isArray(c)) {
      out.push(m);
      continue;
    }
    const kept = c.filter((p: any) => {
      if (p?.type === "tool-call") return resultIds.has(p.toolCallId);
      if (p?.type === "tool-result") return callIds.has(p.toolCallId);
      return true;
    });
    // If sanitizing emptied the message entirely, drop it rather than sending
    // an empty content array, which some providers reject.
    if (kept.length === 0 && c.length > 0) continue;
    out.push(kept.length === c.length ? m : ({ ...(m as any), content: kept } as ModelMessage));
  }
  return out;
}

/**
 * Collapse stale duplicate file reads in the kept history window.
 *
 * When the history contains more than one read_file result for the SAME path,
 * keep the most recent (it reflects the current file state) and replace earlier
 * ones with a one-line stub. This is both a token saving and a correctness win:
 * the model never acts on an outdated copy of a file it subsequently re-read.
 *
 * Pairing is preserved: only the result CONTENT shrinks; the tool_use and
 * tool_result parts themselves remain so tool ids stay balanced.
 * Done deterministically here rather than via a billed compaction call.
 */
export function dedupeFileReads(messages: ModelMessage[]): ModelMessage[] {
  // Map each tool call id to the file path it read, so we can later identify
  // which tool-result messages correspond to read_file calls.
  const pathOf = new Map<string, string>();
  for (const m of messages) {
    const c = (m as any).content;
    if (!Array.isArray(c)) continue;
    for (const p of c) {
      if (p?.type === "tool-call" && p.toolName === "read_file") {
        const path = p.input?.path ?? p.args?.path;
        if (typeof path === "string" && p.toolCallId) pathOf.set(p.toolCallId, path);
      }
    }
  }

  // Count how many read_file results exist per path, and note the message index
  // of the last (most recent) result for each path.
  const count = new Map<string, number>();
  const lastIdx = new Map<string, number>();
  messages.forEach((m, i) => {
    const c = (m as any).content;
    if (!Array.isArray(c)) return;
    for (const p of c) {
      if (p?.type === "tool-result") {
        const path = pathOf.get(p.toolCallId);
        if (path) {
          count.set(path, (count.get(path) ?? 0) + 1);
          lastIdx.set(path, i);
        }
      }
    }
  });

  // Rewrite messages: for any read_file result that has a newer counterpart,
  // replace the output with a short stub so the model knows the stale copy
  // has been superseded without wasting tokens on its full content.
  return messages.map((m, i) => {
    const c = (m as any).content;
    if (!Array.isArray(c)) return m;
    let changed = false;
    const kept = c.map((p: any) => {
      if (p?.type !== "tool-result") return p;
      const path = pathOf.get(p.toolCallId);
      // Keep as-is if: not a read_file result, only one read of this path, or
      // this IS the most recent read of this path.
      if (!path || (count.get(path) ?? 0) < 2 || lastIdx.get(path) === i) return p;
      changed = true;
      return { ...p, output: { type: "text", value: `[earlier read of ${path} elided — a more recent read of this file appears later in the conversation]` } };
    });
    return changed ? ({ ...(m as any), content: kept } as ModelMessage) : m;
  });
}

/**
 * Build the complete context for one model turn.
 *
 * Steps performed:
 *   1. Assemble the stable system prefix: base prompt, optional plan addendum,
 *      verification commands, project memory, and the repo map. These are all
 *      session-stable and together form the byte-identical cacheable prefix.
 *   2. Assemble the volatile per-turn block: current git state and files
 *      retrieved by BM25 for the current user prompt. These are folded into
 *      the current user message (after the cache breakpoint) rather than into
 *      the system prompt, so they never break the prompt cache.
 *   3. Group history into turns, elide old turns beyond RECENT_TURNS, then
 *      trim whole turns from the front until the working set fits within
 *      `inputBudget`. Trimming always drops whole turns to maintain pairing.
 *   4. Deduplicate stale file reads in the kept window, then sanitize any
 *      orphan tool pairs left by interrupted turns.
 *   5. Compute `cacheBreak`: the index of the last settled-history message,
 *      where the provider should insert its cache control marker.
 */
export function buildContext(opts: {
  history: ModelMessage[];
  userText: string;
  userContent?: any;
  model: ModelSpec;
  plan?: boolean;
  cwd?: string;
  recentTurns?: number;
}): BuiltContext {
  const { history, userText, model, plan } = opts;
  const cwd = opts.cwd ?? process.cwd();
  const modelId = model.id;

  // The token budget available for everything we send (system + messages).
  // OUTPUT_RESERVE is held back so the model has room to write its response.
  const inputBudget = Math.max(8_000, model.contextWindow - OUTPUT_RESERVE);

  // ── Step 1: stable system prefix (base + plan + verify + memory + map) ────

  const sections: ContextSection[] = [];
  let system = plan ? BASE_SYSTEM + PLAN_ADDENDUM : BASE_SYSTEM;
  // Identity: the agent must know what it actually is — Gearbox routes
  // per-task, so "what model are you" was answered with a wrong guess
  // (an Anthropic-flavored reply while routed to DeepSeek). Stable per
  // model, so it rides the cached prefix.
  system += `\n\nIdentity: you are the model "${model.label}" (${model.sdkId}) served via ${model.provider}, running inside Gearbox, a multi-provider terminal coding agent that picks a model per task — the active model can change between turns. Answer questions about your identity with exactly this; never guess a different vendor.`;
  sections.push({ name: "system", tokens: countTokens(system, modelId) });

  // Verification commands the project actually exposes (typecheck/test/build, or
  // a language toolchain). Telling the model the real bar up front lets it check
  // its own work in-turn instead of discovering the bar by failing it post-turn.
  // Stable per cwd, so it rides the cached prefix at ~0 recurring cost.
  const checks = safe(() => detectVerificationCommands(cwd), []);
  if (checks.length) {
    const block = checks.map((c) => `- ${c.command}  (${c.reason})`).join("\n");
    system += `\n\n# VERIFICATION COMMANDS (run the relevant ones to check your work before reporting done)\n${block}`;
    sections.push({ name: "verify", tokens: countTokens(block, modelId) });
  }

  // Project memory: GEARBOX.md/CLAUDE.md/AGENTS.md brief plus cross-session
  // remembered facts. Both are capped; see memory.ts for layering details.
  const memory = safe(() => loadProjectMemory(cwd), "");
  if (memory) {
    system += `\n\n# PROJECT MEMORY\n${memory}`;
    sections.push({ name: "memory", tokens: countTokens(memory, modelId) });
  }

  // Repo map: compact structural signatures ranked by import in-degree. Capped
  // at 5% of the input budget so it never dominates the window. See repomap.ts.
  const mapBudget = Math.min(4_000, Math.floor(inputBudget * 0.05));
  const map = safe(() => repoMap(cwd, mapBudget), "");
  if (map) {
    system += `\n\n# REPO MAP (structure for awareness; read files for detail)\n${map}`;
    sections.push({ name: "repomap", tokens: countTokens(map, modelId) });
  }

  const systemTokens = countTokens(system, modelId);

  // ── Step 2: volatile per-turn context (git state + retrieved files) ────────

  // These change every turn (git after each edit, retrieval is prompt-keyed).
  // They are folded into the current user message rather than the system prompt
  // so the stable system + settled history stay cacheable. Still token-accounted
  // in `sections` so /context stays honest about where the budget goes.
  const volatileParts: string[] = [];

  const git = safe(() => gitContext(cwd), "");
  if (git) {
    volatileParts.push(`# GIT CONTEXT (current repository state; do not overwrite unrelated user changes)\n${git}`);
    sections.push({ name: "git", tokens: countTokens(git, modelId) });
  }

  // BM25 retrieval: top-k files scored against the current user prompt, packed
  // within 15% of the input budget. See retrieve.ts for scoring details.
  const retrieveBudget = Math.min(12_000, Math.floor(inputBudget * 0.15));
  const hits = safe(() => retrieveFiles(userText, cwd, 6, retrieveBudget, modelId), []);
  if (hits.length) {
    const block = hits.map((h) => `=== ${h.file} ===\n${h.content}`).join("\n\n");
    volatileParts.push(`# RELEVANT FILES (retrieved for this task)\n${block}`);
    sections.push({ name: "retrieved", tokens: hits.reduce((s, h) => s + h.tokens, 0) });
  }

  // ── Step 3: curated history + current user message, budgeted ───────────────

  // Wrap the volatile block into the current user message. A header labels the
  // block as reference material so the model doesn't treat it as part of the
  // conversation transcript.
  const turnContext = volatileParts.length
    ? `# CONTEXT FOR THIS TURN (current repo state + files retrieved for your task — reference material, not part of our conversation)\n\n${volatileParts.join("\n\n")}`
    : "";
  const baseUserContent = opts.userContent ?? userText;
  const userContent = turnContext
    ? typeof baseUserContent === "string"
      ? [{ type: "text" as const, text: turnContext }, { type: "text" as const, text: baseUserContent }]
      : [{ type: "text" as const, text: turnContext }, ...(baseUserContent as any[])]
    : baseUserContent;
  const userMsg: ModelMessage = { role: "user", content: userContent as any };
  const userTokens = msgTokens(userMsg, modelId);

  // Split history into turns, then mark the boundary between "old" turns that
  // will be elided and "recent" turns kept verbatim.
  const turns = groupTurns(history);
  const recent = opts.recentTurns ?? RECENT_TURNS;
  const split = Math.max(0, turns.length - recent);

  // Apply elision to old turns: assistant text survives, tool exchanges are
  // stripped. Recent turns are projected as-is (full tool IO).
  const projected: ModelMessage[][] = turns.map((t, i) => (i < split ? elideTurn(t) : t));

  // Trim the oldest whole turns until the projected history fits in the
  // remaining budget. Each iteration drops exactly one complete turn so tool
  // pairing is never broken across the trim boundary.
  let historyBudget = inputBudget - systemTokens - userTokens;
  const turnCost = (t: ModelMessage[]) => t.reduce((s, m) => s + msgTokens(m, modelId), 0);
  let total = projected.reduce((s, t) => s + turnCost(t), 0);
  while (projected.length && total > historyBudget) {
    total -= turnCost(projected.shift()!);
  }

  // ── Step 4: deduplicate stale reads and sanitize orphan tool pairs ─────────

  // Collapse duplicate read_file results in the kept window: free token savings
  // and a correctness win (model never acts on an outdated file copy).
  const flat = dedupeFileReads(projected.flat());
  const historyTokens = flat.reduce((s, m) => s + msgTokens(m, modelId), 0);
  sections.push({ name: "history", tokens: historyTokens });
  sections.push({ name: "user", tokens: userTokens });

  // A kept recent turn may carry an unpaired tool_use (e.g. an interrupted turn
  // where the agent never received the tool result). Sanitize before sending so
  // the request is always structurally valid.
  const finalMessages = sanitizeToolPairs([...flat, userMsg]);

  // ── Step 5: compute the cache breakpoint ───────────────────────────────────

  // The breakpoint is the index of the last settled-history message, i.e. the
  // message just before the current user message. Computed after sanitize so a
  // dropped orphan part cannot shift the index. -1 means no settled history
  // exists yet (the first turn), so only the system block is cached.
  const cacheBreak = finalMessages.length - 2;
  return { system, messages: finalMessages, sections, cacheBreak };
}

/**
 * Execute `fn` and return its result. On any thrown error, return `fallback`
 * instead. Used throughout buildContext to keep partial failures from aborting
 * the turn: a missing GEARBOX.md, an unreadable git repo, or a retrieval error
 * should degrade gracefully rather than crash the request.
 */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
