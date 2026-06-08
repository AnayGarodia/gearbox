// The Context Engine: projects the full conversation `history` (the ledger /
// source of truth in App's msgRef) into a bounded, model-aware working set per
// turn. Experiments (experiments/context/FINDINGS.md) proved this is ~16×
// cheaper per turn than dumping the raw transcript, stays bounded instead of
// overflowing, and makes the same correct edits — so curation is what enables
// routing (a switched model gets a small, clean context, not the whole history).
//
// Assembly order (stable cacheable prefix first, volatile per-turn context last):
//   system   = base prompt + plan addendum + verification commands + project memory
//              + repo map   (session-stable → stays a byte-identical cached prefix)
//   messages = curated history + a user turn that FOLDS IN the volatile context
//              (git state + freshly retrieved files). The cache breakpoint sits at
//              the end of the settled history, so that volatile tail rides after it
//              and never busts the cached prefix. (Earlier this volatile content
//              lived in `system` and broke the cache on every turn.)
//
// THE INVARIANT: never split a tool_use from its tool_result. Curation and
// trimming operate only at whole-turn boundaries; eliding an old turn drops
// BOTH the assistant's tool-call parts AND the paired tool-result messages
// together, so the projected messages always have balanced tool ids.
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

// Tokens held back from the context window for the model's output + safety.
const OUTPUT_RESERVE = 32_000;
const RECENT_TURNS = 3; // most-recent turns kept verbatim (tool IO intact)
const PER_MESSAGE_OVERHEAD = 4; // rough role/wrapping tokens per message

export interface ContextSection {
  name: string;
  tokens: number;
}

export interface BuiltContext {
  system: string;
  messages: ModelMessage[];
  sections: ContextSection[];
  // Index of the last SETTLED-history message — where the cacheable prefix ends.
  // The per-turn volatile context (git + retrieved files) rides in the final user
  // message AFTER this, so the stable system + growing history stay a byte-identical
  // cacheable prefix across turns. -1 when there's no settled history yet.
  cacheBreak: number;
}

// ── token helpers ──
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

export function msgTokens(m: ModelMessage, modelId?: string): number {
  return countTokens(textOf((m as any).content), modelId) + PER_MESSAGE_OVERHEAD;
}

// ── turn grouping & elision (the invariant lives here) ──
// A turn = a user message and everything that follows until the next user
// message (the assistant text + its tool-calls + the tool-result messages).
export function groupTurns(history: ModelMessage[]): ModelMessage[][] {
  const turns: ModelMessage[][] = [];
  for (const m of history) {
    if (m.role === "user" || turns.length === 0) turns.push([m]);
    else turns[turns.length - 1]!.push(m);
  }
  return turns;
}

// Elide an old turn: keep user + assistant *text*, drop the tool exchange
// entirely (both the assistant's tool-call parts AND the role:"tool" results).
// Dropping both sides together is what keeps tool ids balanced.
function elideTurn(turn: ModelMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of turn) {
    if (m.role === "tool") continue; // drop tool results
    if (m.role === "assistant" && Array.isArray((m as any).content)) {
      const kept = (m as any).content.filter((p: any) => typeof p === "string" || p?.type === "text");
      if (kept.length) out.push({ ...(m as any), content: kept } as ModelMessage);
      // assistant message that was only tool-calls → dropped
    } else {
      out.push(m);
    }
  }
  return out;
}

/**
 * Drop any tool-call that has no matching tool-result and any tool-result with
 * no matching tool-call, so the message array is always valid to send (every
 * tool_use ↔ tool_result paired). Needed because an INTERRUPTED turn can leave
 * a trailing assistant tool_use whose result never arrived; without this the
 * next request 400s. Idempotent — a balanced array passes through unchanged.
 */
export function sanitizeToolPairs(messages: ModelMessage[]): ModelMessage[] {
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
    if (kept.length === 0 && c.length > 0) continue; // message emptied by sanitizing → drop
    out.push(kept.length === c.length ? m : ({ ...(m as any), content: kept } as ModelMessage));
  }
  return out;
}

/**
 * Collapse stale duplicate file reads. When the kept history holds more than one
 * read_file result for the SAME path, keep the most recent (it reflects the
 * current file) and replace the earlier ones with a one-line stub. Free token
 * savings AND a correctness win: the model never acts on an outdated copy. Keeps
 * tool_use/tool_result pairing intact — only the result CONTENT shrinks, the parts
 * stay. Done deterministically here rather than via a billed compaction call.
 */
export function dedupeFileReads(messages: ModelMessage[]): ModelMessage[] {
  // read_file call id → the path it read
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
  // Per path: how many results, and the index of the LAST (most recent) one.
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
  return messages.map((m, i) => {
    const c = (m as any).content;
    if (!Array.isArray(c)) return m;
    let changed = false;
    const kept = c.map((p: any) => {
      if (p?.type !== "tool-result") return p;
      const path = pathOf.get(p.toolCallId);
      if (!path || (count.get(path) ?? 0) < 2 || lastIdx.get(path) === i) return p; // unique or most-recent → keep
      changed = true;
      return { ...p, output: { type: "text", value: `[earlier read of ${path} elided — a more recent read of this file appears later in the conversation]` } };
    });
    return changed ? ({ ...(m as any), content: kept } as ModelMessage) : m;
  });
}

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
  const inputBudget = Math.max(8_000, model.contextWindow - OUTPUT_RESERVE);

  // ── stable system prefix: base + plan + memory + repo map + retrieved code ──
  const sections: ContextSection[] = [];
  let system = plan ? BASE_SYSTEM + PLAN_ADDENDUM : BASE_SYSTEM;
  sections.push({ name: "system", tokens: countTokens(system, modelId) });

  // Verification commands the project actually exposes (typecheck/test/build, or a
  // language toolchain). Telling the model the real bar UP FRONT lets it check its
  // own work in-turn instead of discovering the bar by failing it post-turn. Stable
  // per cwd, so it rides the cached prefix at ~0 recurring cost.
  const checks = safe(() => detectVerificationCommands(cwd), []);
  if (checks.length) {
    const block = checks.map((c) => `- ${c.command}  (${c.reason})`).join("\n");
    system += `\n\n# VERIFICATION COMMANDS (run the relevant ones to check your work before reporting done)\n${block}`;
    sections.push({ name: "verify", tokens: countTokens(block, modelId) });
  }

  const memory = safe(() => loadProjectMemory(cwd), "");
  if (memory) {
    system += `\n\n# PROJECT MEMORY\n${memory}`;
    sections.push({ name: "memory", tokens: countTokens(memory, modelId) });
  }

  const mapBudget = Math.min(4_000, Math.floor(inputBudget * 0.05));
  const map = safe(() => repoMap(cwd, mapBudget), "");
  if (map) {
    system += `\n\n# REPO MAP (structure for awareness; read files for detail)\n${map}`;
    sections.push({ name: "repomap", tokens: countTokens(map, modelId) });
  }

  const systemTokens = countTokens(system, modelId);

  // ── volatile per-turn context: git state + files retrieved for THIS prompt ──
  // These change every turn (git after each edit; retrieval is prompt-keyed), so
  // keeping them in the system prefix busted the prompt cache on every turn. They
  // are folded into the current user message instead, riding AFTER the cache
  // breakpoint, so the stable system + settled history stay cacheable. Still token-
  // accounted in `sections` so /context stays honest about where the budget goes.
  const volatileParts: string[] = [];
  const git = safe(() => gitContext(cwd), "");
  if (git) {
    volatileParts.push(`# GIT CONTEXT (current repository state; do not overwrite unrelated user changes)\n${git}`);
    sections.push({ name: "git", tokens: countTokens(git, modelId) });
  }
  const retrieveBudget = Math.min(12_000, Math.floor(inputBudget * 0.15));
  const hits = safe(() => retrieveFiles(userText, cwd, 6, retrieveBudget, modelId), []);
  if (hits.length) {
    const block = hits.map((h) => `=== ${h.file} ===\n${h.content}`).join("\n\n");
    volatileParts.push(`# RELEVANT FILES (retrieved for this task)\n${block}`);
    sections.push({ name: "retrieved", tokens: hits.reduce((s, h) => s + h.tokens, 0) });
  }

  // ── curated history + current user message (with the volatile context), budgeted ──
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

  const turns = groupTurns(history);
  const recent = opts.recentTurns ?? RECENT_TURNS;
  const split = Math.max(0, turns.length - recent);
  const projected: ModelMessage[][] = turns.map((t, i) => (i < split ? elideTurn(t) : t));

  // Trim oldest whole turns until the working set fits (pair-safe — whole turns).
  let historyBudget = inputBudget - systemTokens - userTokens;
  const turnCost = (t: ModelMessage[]) => t.reduce((s, m) => s + msgTokens(m, modelId), 0);
  let total = projected.reduce((s, t) => s + turnCost(t), 0);
  while (projected.length && total > historyBudget) {
    total -= turnCost(projected.shift()!);
  }

  // Collapse stale duplicate file reads in the kept (verbatim recent) window
  // before accounting — free token savings, and the model never sees an outdated
  // copy of a file it re-read.
  const flat = dedupeFileReads(projected.flat());
  const historyTokens = flat.reduce((s, m) => s + msgTokens(m, modelId), 0);
  sections.push({ name: "history", tokens: historyTokens });
  sections.push({ name: "user", tokens: userTokens });

  // Defensive: a kept recent turn could carry an unpaired tool_use (e.g. an
  // interrupted turn). Sanitize so the send is always valid.
  const finalMessages = sanitizeToolPairs([...flat, userMsg]);
  // Cache breakpoint = the last SETTLED message (the one before the user turn).
  // Computed AFTER sanitize so a dropped orphan can't shift the index. -1 when the
  // user message is the only one (first turn) → only the system block caches.
  const cacheBreak = finalMessages.length - 2;
  return { system, messages: finalMessages, sections, cacheBreak };
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
