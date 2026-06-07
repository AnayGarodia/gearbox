// The Context Engine: projects the full conversation `history` (the ledger /
// source of truth in App's msgRef) into a bounded, model-aware working set per
// turn. Experiments (experiments/context/FINDINGS.md) proved this is ~16×
// cheaper per turn than dumping the raw transcript, stays bounded instead of
// overflowing, and makes the same correct edits — so curation is what enables
// routing (a switched model gets a small, clean context, not the whole history).
//
// Assembly order (Anthropic-style, stable prefix first for prompt caching):
//   system  = base prompt + plan addendum + project memory + repo map + retrieved code
//   messages = curated history + current user message
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

export const BASE_SYSTEM = `You are Gearbox, a precise terminal coding agent.
Work in small, verifiable steps. Use the tools to read before you write, and
run tests or commands to check your work rather than assuming. Prefer the
smallest change that solves the problem. Be concise in prose; let the diffs and
test output speak. When done, say briefly what you changed and how you verified it.
Style: no em dashes (—); use a comma, a period, or " · " instead. When you state a
count (lines, files, changes), make it match the actual diff exactly.
When a sizable, self-contained sub-task would be handled better or cheaper by a
different model (bulk edits, a focused refactor, research, generation), use the
\`delegate\` tool: it spins up a sub-agent on the best-routed model and returns its
report. Make the task self-contained — the sub-agent can't see this conversation.
Do small things yourself; delegate the chunks.`;

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

  const memory = safe(() => loadProjectMemory(cwd), "");
  if (memory) {
    system += `\n\n# PROJECT MEMORY\n${memory}`;
    sections.push({ name: "memory", tokens: countTokens(memory, modelId) });
  }

  const git = safe(() => gitContext(cwd), "");
  if (git) {
    system += `\n\n# GIT CONTEXT (current repository state; do not overwrite unrelated user changes)\n${git}`;
    sections.push({ name: "git", tokens: countTokens(git, modelId) });
  }

  const mapBudget = Math.min(4_000, Math.floor(inputBudget * 0.05));
  const map = safe(() => repoMap(cwd, mapBudget), "");
  if (map) {
    system += `\n\n# REPO MAP (structure for awareness; read files for detail)\n${map}`;
    sections.push({ name: "repomap", tokens: countTokens(map, modelId) });
  }

  const retrieveBudget = Math.min(8_000, Math.floor(inputBudget * 0.15));
  const hits = safe(() => retrieveFiles(userText, cwd, 6, retrieveBudget, modelId), []);
  if (hits.length) {
    const block = hits.map((h) => `=== ${h.file} ===\n${h.content}`).join("\n\n");
    system += `\n\n# RELEVANT FILES (retrieved for this task)\n${block}`;
    sections.push({ name: "retrieved", tokens: hits.reduce((s, h) => s + h.tokens, 0) });
  }

  const systemTokens = countTokens(system, modelId);

  // ── curated history + current user message, budgeted ──
  const userMsg: ModelMessage = { role: "user", content: opts.userContent ?? userText };
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

  const flat = projected.flat();
  const historyTokens = flat.reduce((s, m) => s + msgTokens(m, modelId), 0);
  sections.push({ name: "history", tokens: historyTokens });
  sections.push({ name: "user", tokens: userTokens });

  // Defensive: a kept recent turn could carry an unpaired tool_use (e.g. an
  // interrupted turn). Sanitize so the send is always valid.
  return { system, messages: sanitizeToolPairs([...flat, userMsg]), sections };
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
