// Autonomous context policy: decide when to compact and what the compaction
// should preserve, keeping App as an orchestrator rather than a policy engine.
import type { ModelMessage } from "ai";
import type { ContextSection } from "./builder.ts";
import { estimateHistoryTokens, shouldAutoCompact } from "./compact.ts";

export interface ContextGovernorInput {
  history: ModelMessage[];
  prompt: string;
  changedFiles?: string[];
  failures?: string[];
  sections?: ContextSection[];
  contextWindow: number;
  modelId?: string;
}

export interface ContextDecision {
  shouldCompact: boolean;
  reason: string;
  keepRecent: number;
  focus?: string;
  pressure: number;
  historyTokens: number;
  overheadTokens: number;
}

const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
};

export function contextOverhead(sections: ContextSection[] = []): number {
  return sections.filter((s) => s.name !== "history" && s.name !== "user").reduce((sum, s) => sum + s.tokens, 0);
}

export function inferCompactionFocus(input: Pick<ContextGovernorInput, "prompt" | "changedFiles" | "failures">): string | undefined {
  const parts: string[] = [];
  const prompt = clip(input.prompt, 140);
  if (prompt) parts.push(`current task: ${prompt}`);
  const files = [...new Set(input.changedFiles ?? [])].slice(0, 6);
  if (files.length) parts.push(`files: ${files.join(", ")}`);
  const failures = [...new Set(input.failures ?? [])].slice(0, 3).map((f) => clip(f, 100));
  if (failures.length) parts.push(`failures: ${failures.join(" | ")}`);
  return parts.length ? parts.join("; ") : undefined;
}

export function contextGovernor(input: ContextGovernorInput): ContextDecision {
  const historyTokens = estimateHistoryTokens(input.history, input.modelId);
  const overheadTokens = contextOverhead(input.sections);
  const budget = Math.max(8_000, input.contextWindow - 32_000);
  const used = historyTokens + Math.max(0, overheadTokens);
  const pressure = budget > 0 ? used / budget : 1;
  const shouldCompact = shouldAutoCompact(historyTokens, overheadTokens, input.contextWindow);
  const keepRecent = pressure >= 0.9 ? 2 : pressure >= 0.82 ? 3 : 4;
  const pct = Math.round(pressure * 100);
  return {
    shouldCompact,
    reason: shouldCompact ? `projected context ${pct}% of input budget` : `projected context ${pct}% of input budget; below auto-compact threshold`,
    keepRecent,
    focus: shouldCompact ? inferCompactionFocus(input) : undefined,
    pressure,
    historyTokens,
    overheadTokens,
  };
}
