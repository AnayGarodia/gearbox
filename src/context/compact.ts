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
import { groupTurns, textOf, msgTokens } from "./builder.ts";

// Injectable so tests can compact without a live model call.
export type Summarizer = (transcript: string) => Promise<string>;

const SUMMARY_SYSTEM = `You compress a coding-session transcript into durable notes for an AI agent that will continue the work. Preserve, as terse bullet points:
- the user's goals and any decisions made
- files created/edited and what changed in each
- commands/tests run and their outcomes
- facts learned about the codebase
- open threads / what's left to do
Drop chit-chat and raw file dumps. Be specific (names, paths, signatures). Output only the notes.`;

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

/** Render turns as a readable transcript for the summarizer. */
function renderTranscript(turns: ModelMessage[][]): string {
  const lines: string[] = [];
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
 * recent turns stay whole (tool pairing intact). Returns null when there's
 * nothing old enough to be worth compacting, or if summarization fails/empties.
 */
export async function compactHistory(opts: {
  history: ModelMessage[];
  summarize: Summarizer;
  keepRecent?: number;
}): Promise<{ messages: ModelMessage[]; summarizedTurns: number; before: number; after: number } | null> {
  const { history, summarize } = opts;
  const keepRecent = opts.keepRecent ?? 4;
  const turns = groupTurns(history);
  const split = turns.length - keepRecent;
  if (split < 1) return null; // nothing old enough to compact

  const old = turns.slice(0, split);
  const recent = turns.slice(split);
  const transcript = renderTranscript(old);
  if (!transcript.trim()) return null;

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

  const messages: ModelMessage[] = [
    { role: "user", content: "Summarize what we've done so far into durable notes I can continue from." },
    { role: "assistant", content: `Notes from earlier in this session:\n${summary}` },
    ...recent.flat(),
  ];
  const before = estimateHistoryTokens(history);
  const after = estimateHistoryTokens(messages);
  return { messages, summarizedTurns: old.length, before, after };
}
