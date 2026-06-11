// Auto-compaction: when the conversation grows long, summarize the OLD turns
// with a (cheap, delegated) model instead of dropping them — the builder's
// hard-trim loses information; this preserves the gist. Experiments
// (experiments/context/FINDINGS.md) showed curation is the routing enabler;
// compaction is the same idea applied across time, and the first cheap-model
// sub-task delegation (the model is chosen via the selector seam with
// kind:"summarize", so the router can route it to haiku later).
//
// THE INVARIANT (same as builder.ts): the summary is plain text and the kept
// recent turns are whole, so the rewritten history never splits a tool_use
// from its tool_result.
import { generateText, type ModelMessage } from "ai";
import { resolveModel, type ModelSpec } from "../providers.ts";
import type { ResolvedCreds } from "../accounts/types.ts";
import { groupTurns, textOf, msgTokens, elideTurn } from "./builder.ts";
import { countTokens } from "../model/tokens.ts";
import { parseCompactionSummary } from "./compact-summary.ts";
import { applyVerificationPatch, verifyCompactionSummary } from "./compact-verify.ts";

// Injectable so tests can compact without a live model call.
export type Summarizer = (transcript: string) => Promise<string>;

const SUMMARY_SYSTEM = `You compress a coding-session transcript into durable notes for an AI agent that will continue the work with NO other memory of it.
Output ONLY valid JSON with this shape:
{
  "goals": string[],
  "decisions": string[],
  "files": [{"path": string, "change": string}],
  "commands": [{"command": string, "outcome": string}],
  "facts": string[],
  "openThreads": string[],
  "topics": [{"title": string, "notes": string[], "files": string[]}]
}
Preserve:
- the user's goals, constraints, and decisions made (with the why, when stated)
- files created/edited/read and what changed or mattered in each
- commands/tests run and outcomes (pass/fail, key error lines)
- facts learned about the codebase (paths, function names, gotchas)
- open threads / what's left to do, and the current in-progress step if any
- topic/task clusters when the old transcript covered multiple separable threads
Rules: copy identifiers, file paths, and commands EXACTLY — never paraphrase a name. Record only what the transcript shows; do not infer or invent. Drop chit-chat and raw file dumps. The JSON MUST be much shorter than the transcript; if in doubt, cut prose, never facts.`;

/** A Summarizer backed by a real model (chosen by the caller via the selector).
 *  Pass the model's account creds so compaction works for STORED API accounts,
 *  not just an env key (it silently never compacted otherwise). */
export function modelSummarizer(model: ModelSpec, creds?: ResolvedCreds, signal?: AbortSignal): Summarizer {
  return async (transcript: string) => {
    const { text } = await generateText({
      model: resolveModel(model, creds),
      system: SUMMARY_SYSTEM,
      prompt: transcript,
      abortSignal: signal,
      maxRetries: 1, // best-effort compaction — don't inherit the SDK's 3-attempt storm
    });
    return text.trim();
  };
}

/** Estimate the token cost of a full message history (for the compaction trigger). */
export function estimateHistoryTokens(history: ModelMessage[], modelId?: string): number {
  return history.reduce((s, m) => s + msgTokens(m, modelId), 0);
}

// Auto-compact when the FULL projected context (history + the per-turn
// overhead of system/memory/repomap/retrieval) nears the answering model's
// window. The old trigger measured history alone, so a 15-20k overhead meant
// it fired too late relative to the real window.
const COMPACT_AT = 0.75;
const COMPACT_OUTPUT_RESERVE = 32_000;

/** Pure trigger predicate for auto-compaction (App wires the live numbers). */
export function shouldAutoCompact(historyTokens: number, overheadTokens: number, contextWindow: number): boolean {
  const budget = Math.max(8_000, contextWindow - COMPACT_OUTPUT_RESERVE);
  return historyTokens + Math.max(0, overheadTokens) > budget * COMPACT_AT;
}

/** What a compaction pass actually returned. `how` is the honest description of
 *  which escalation rung fired ("summarized N turns" | "elided M turns" |
 *  "truncated K oversized tool results") so the caller's notice tells the truth
 *  instead of "nothing old enough" when a deeper rung did the work. */
export interface CompactResult {
  messages: ModelMessage[];
  summarizedTurns: number;
  before: number;
  after: number;
  how: string;
  archive?: {
    id: string;
    instruction?: string;
    turns: { start: number; end: number };
    messages: ModelMessage[];
    summary?: string;
    structured?: import("../session.ts").CompactionSummary;
    verification?: import("../session.ts").CompactionVerification;
  };
}

// Per-result token cap for the final escalation rung: a single oversized
// tool result (one mega read_file) is capped in place rather than letting it
// pin the whole window above the compaction threshold forever.
const TRUNCATE_RESULT_TOKENS = 2_000;
const TRUNCATION_MARKER = "\n[output truncated during compaction — re-read the file if needed]";

// Sentinel preamble for mechanical elision. Detected by EXACT match so repeated
// elideHistory calls reuse one preamble instead of stacking a new synthetic
// user→assistant pair per pass.
const ELIDE_PREAMBLE_USER = "Compact the earlier conversation.";
const ELIDE_PREAMBLE_ASSISTANT = "Earlier turns follow with their full tool output elided — each turn keeps its prose plus a one-line trail per tool call.";

/** Strip a previously-injected elision preamble (exact sentinel match on
 *  history[0]) so a fresh one can be prepended without stacking. */
function stripElidePreamble(history: ModelMessage[]): ModelMessage[] {
  if (history[0]?.role !== "user" || history[0].content !== ELIDE_PREAMBLE_USER) return history;
  const framing = history[1];
  return history.slice(framing?.role === "assistant" && framing.content === ELIDE_PREAMBLE_ASSISTANT ? 2 : 1);
}

/**
 * Cap each oversized tool-result part IN PLACE (head-truncated with a marker
 * telling the model to re-read if it needs the rest). The tool-call/tool-result
 * PAIRING is untouched — only result content shrinks — so this is safe to apply
 * anywhere, including the very last turn. Pure.
 */
export function truncateToolResults(messages: ModelMessage[], maxTokensPerResult = TRUNCATE_RESULT_TOKENS, modelId?: string): { messages: ModelMessage[]; truncated: number } {
  let truncated = 0;
  const out = messages.map((m) => {
    if (m.role !== "tool" || !Array.isArray((m as any).content)) return m;
    let changed = false;
    const kept = (m as any).content.map((p: any) => {
      if (p?.type !== "tool-result") return p;
      const raw = typeof p.output === "string" ? p.output : p.output?.value;
      if (typeof raw !== "string" || countTokens(raw, modelId) <= maxTokensPerResult) return p;
      changed = true;
      truncated++;
      // Start from the ~4 chars/token estimate, then verify with a real count —
      // CJK/base64-dense content runs 2-4x tokens per char and would otherwise
      // stay over budget after "truncation".
      let body = raw.slice(0, maxTokensPerResult * 4);
      while (body.length > 256 && countTokens(body, modelId) > maxTokensPerResult) body = body.slice(0, Math.floor(body.length / 2));
      const capped = body + TRUNCATION_MARKER;
      return { ...p, output: typeof p.output === "string" ? capped : { ...p.output, value: capped } };
    });
    return changed ? ({ ...(m as any), content: kept } as ModelMessage) : m;
  });
  return { messages: out, truncated };
}

/**
 * The LAST escalation rungs, shared by both compaction paths: when no turn is
 * old enough to summarize/elide away (a single mega-turn can fill the window),
 * shrink INSIDE the recent window instead of giving up —
 *   1. elide every kept turn except the last (tool IO distilled to one line);
 *   2. truncate oversized tool results in place, INCLUDING the last turn.
 * Each rung keeps the after >= before honesty check; null only when the
 * history is genuinely small (no rung saves anything).
 */
function shrinkRecentWindow(history: ModelMessage[], modelId?: string): CompactResult | null {
  const before = estimateHistoryTokens(history, modelId);
  const turns = groupTurns(history);
  if (turns.length > 1) {
    const messages: ModelMessage[] = [...turns.slice(0, -1).flatMap((t) => elideTurn(t)), ...turns[turns.length - 1]!];
    const after = estimateHistoryTokens(messages, modelId);
    if (after < before) {
      const n = turns.length - 1;
      return { messages, summarizedTurns: n, before, after, how: `elided ${n} turn${n > 1 ? "s" : ""}` };
    }
  }
  const { messages, truncated } = truncateToolResults(history, TRUNCATE_RESULT_TOKENS, modelId);
  if (truncated > 0) {
    const after = estimateHistoryTokens(messages, modelId);
    if (after < before) return { messages, summarizedTurns: 0, before, after, how: `truncated ${truncated} oversized tool result${truncated > 1 ? "s" : ""}` };
  }
  return null;
}

/**
 * MODEL-FREE compaction: mechanically elide every turn older than `keepRecent`
 * (tool exchanges distilled to one line each via builder's elideTurn). Used
 * when no API-key summarizer is available (subscription-only sessions) and as
 * the fallback when the summarizer fails — /compact must always be able to
 * shrink the history. ESCALATION LADDER: if nothing is old enough at the given
 * keepRecent, it is lowered (n-1 … 1); if there is still nothing to elide away
 * (≤1 turn), it shrinks INSIDE the window (elide all but the last turn, then
 * truncate oversized tool results in place). Returns null only when the
 * history is genuinely small — no rung saves any tokens.
 */
export function elideHistory(history: ModelMessage[], keepRecent = 4): CompactResult | null {
  const base = stripElidePreamble(history);
  const before = estimateHistoryTokens(history);
  const turns = groupTurns(base);
  for (let k = Math.min(keepRecent, turns.length - 1); k >= 1; k--) {
    const split = turns.length - k;
    if (split < 1) continue;
    const messages: ModelMessage[] = [
      { role: "user", content: ELIDE_PREAMBLE_USER },
      { role: "assistant", content: ELIDE_PREAMBLE_ASSISTANT },
      ...turns.slice(0, split).flatMap((t) => elideTurn(t)),
      ...turns.slice(split).flat(),
    ];
    const after = estimateHistoryTokens(messages);
    if (after < before) return { messages, summarizedTurns: split, before, after, how: `elided ${split} turn${split > 1 ? "s" : ""}` };
  }
  return shrinkRecentWindow(base);
}

/** Render turns as a readable transcript for the summarizer. */
function renderTranscript(turns: ModelMessage[][], focusInstruction?: string): string {
  const lines: string[] = [];
  if (focusInstruction?.trim()) {
    lines.push(`Compaction focus: preserve details relevant to "${focusInstruction.trim()}". Keep other durable facts only if they affect future work.`);
  }
  for (const turn of turns) {
    for (const m of turn) {
      const who = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : m.role === "tool" ? "Tool" : m.role;
      const body = textOf((m as any).content).trim();
      if (body) lines.push(`${who}: ${body}`);
    }
  }
  return lines.join("\n");
}

/**
 * Compact `history`: summarize every turn older than `keepRecent` into a single
 * synthetic user→assistant exchange, then keep the recent turns verbatim. The
 * recent turns stay whole (tool pairing intact). ESCALATION LADDER: when nothing
 * is old enough at the requested keepRecent, it is lowered (n-1 … 1); with ≤1
 * turn (one mega-turn filling the window) it falls through to the model-free
 * intra-window rungs (elide all but the last turn, then truncate oversized tool
 * results in place). Returns null only when the history is genuinely small;
 * throws when the summarizer itself fails.
 */
export async function compactHistory(opts: {
  history: ModelMessage[];
  summarize: Summarizer;
  keepRecent?: number;
  focusInstruction?: string;
  archiveId?: string;
}): Promise<CompactResult | null> {
  const { history, summarize } = opts;
  const turns = groupTurns(history);
  // Lower keepRecent until at least one turn is old enough to summarize away.
  const keepRecent = Math.min(opts.keepRecent ?? 4, Math.max(1, turns.length - 1));
  const split = turns.length - keepRecent;
  if (split < 1) return shrinkRecentWindow(history); // ≤1 turn: shrink inside the window

  const old = turns.slice(0, split);
  const recent = turns.slice(split);
  const transcript = renderTranscript(old, opts.focusInstruction);
  if (!transcript.trim()) return shrinkRecentWindow(history);

  let summary: string;
  try {
    summary = await summarize(transcript);
  } catch (e: any) {
    // A summarizer FAILURE is not "nothing to do" — conflating them made
    // /compact report "nothing old enough" while it was actually broken.
    // Keep the original history and tell the caller why.
    throw new Error(e?.message ?? "summarizer failed");
  }
  if (!summary.trim()) throw new Error("summarizer returned an empty summary");
  const parsed = parseCompactionSummary(summary);
  const verification = verifyCompactionSummary(parsed.text, old.flat());
  const verifiedSummary = applyVerificationPatch(parsed.text, verification);

  const archiveId = opts.archiveId ?? "compact";
  const range = { start: 1, end: old.length };
  const pointer = `[compaction archive: ${archiveId} · original turns ${range.start}-${range.end} retained in session metadata]`;
  const focus = opts.focusInstruction?.trim();
  const messages: ModelMessage[] = [
    { role: "user", content: focus ? `Summarize what we've done so far into durable notes I can continue from. Focus: ${focus}` : "Summarize what we've done so far into durable notes I can continue from." },
    { role: "assistant", content: `Notes from earlier in this session:\n${pointer}\n\n${verifiedSummary}` },
    ...recent.flat(),
  ];
  const before = estimateHistoryTokens(history);
  const after = estimateHistoryTokens(messages);
  // A verbose summarizer can EXPAND the history ("compress" prompts sometimes
  // grow it). Never return a result that frees nothing — fall through to the
  // mechanical rungs, which carry their own after < before checks.
  if (after >= before) return elideHistory(history, opts.keepRecent);
  return {
    messages,
    summarizedTurns: old.length,
    before,
    after,
    how: `summarized ${old.length} turn${old.length > 1 ? "s" : ""}`,
    archive: {
      id: archiveId,
      instruction: focus || undefined,
      turns: range,
      messages: old.flat(),
      summary: verifiedSummary,
      structured: parsed.structured,
      verification,
    },
  };
}
