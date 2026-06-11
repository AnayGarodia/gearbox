// Structured compaction summary parsing/rendering. Summarizers are asked for
// JSON, but compaction remains robust when they return prose.
import type { CompactionSummary } from "../session.ts";

const emptySummary = (): CompactionSummary => ({
  goals: [],
  decisions: [],
  files: [],
  commands: [],
  facts: [],
  openThreads: [],
  topics: [],
});

const strings = (v: unknown): string[] => Array.isArray(v) ? v.map((x) => String(x ?? "").trim()).filter(Boolean) : [];

function extractJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const raw = fenced ?? trimmed;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function parseCompactionSummary(text: string): { text: string; structured?: CompactionSummary } {
  const parsed = extractJson(text);
  if (!parsed || typeof parsed !== "object") return { text: text.trim() };
  const obj = parsed as Record<string, unknown>;
  const out = emptySummary();
  out.goals = strings(obj.goals);
  out.decisions = strings(obj.decisions);
  out.facts = strings(obj.facts);
  out.openThreads = strings(obj.openThreads);
  out.files = Array.isArray(obj.files)
    ? obj.files.map((f: any) => ({ path: String(f?.path ?? "").trim(), change: String(f?.change ?? "").trim() })).filter((f) => f.path || f.change)
    : [];
  out.commands = Array.isArray(obj.commands)
    ? obj.commands.map((c: any) => ({ command: String(c?.command ?? "").trim(), outcome: String(c?.outcome ?? "").trim() })).filter((c) => c.command || c.outcome)
    : [];
  out.topics = Array.isArray(obj.topics)
    ? obj.topics.map((t: any) => ({
        title: String(t?.title ?? "").trim(),
        notes: strings(t?.notes),
        files: strings(t?.files),
      })).filter((t) => t.title || t.notes.length || (t.files?.length ?? 0))
    : [];
  return { text: renderCompactionSummary(out), structured: out };
}

export function renderCompactionSummary(summary: CompactionSummary): string {
  const sections: string[] = [];
  const bullets = (title: string, xs: string[]) => {
    if (xs.length) sections.push(`${title}\n${xs.map((x) => `- ${x}`).join("\n")}`);
  };
  bullets("Goals", summary.goals);
  bullets("Decisions", summary.decisions);
  if (summary.files.length) sections.push(`Files\n${summary.files.map((f) => `- ${f.path}${f.change ? `: ${f.change}` : ""}`).join("\n")}`);
  if (summary.commands.length) sections.push(`Commands\n${summary.commands.map((c) => `- ${c.command}${c.outcome ? `: ${c.outcome}` : ""}`).join("\n")}`);
  bullets("Facts", summary.facts);
  bullets("Open threads", summary.openThreads);
  if (summary.topics.length) {
    sections.push(`Topics\n${summary.topics.map((t) => {
      const files = t.files?.length ? ` (${t.files.join(", ")})` : "";
      const notes = t.notes.length ? `\n${t.notes.map((n) => `  - ${n}`).join("\n")}` : "";
      return `- ${t.title || "untitled"}${files}${notes}`;
    }).join("\n")}`);
  }
  return sections.join("\n\n").trim();
}
