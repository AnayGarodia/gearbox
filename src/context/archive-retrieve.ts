// Retrieval over compacted session archives. This makes compaction cold storage
// active again: old turns can be recalled automatically when a future prompt,
// file, or failure resembles the archived work.
import type { ModelMessage } from "ai";
import type { CompactionArchive } from "../session.ts";
import { countTokens } from "../model/tokens.ts";
import { memoryGraphArchiveEvidence } from "./memory-graph.ts";

export interface RetrievedArchive {
  archiveId: string;
  title: string;
  summary: string;
  excerpt?: string;
  provenance: string[];
  score: number;
  tokens: number;
}

const STOP = new Set("the a an to is it of and or in on for with that this when should i me my be do does did into out up as at by current task files failures".split(" "));
const MAX_SUMMARY_CHARS = 1_800;
const MAX_EXCERPT_CHARS = 1_200;

function terms(s: string): string[] {
  const out: string[] = [];
  for (const part of s.split(/[^A-Za-z0-9_/.-]+/)) {
    for (const w of part.match(/[A-Z]+(?![a-z])|[A-Z][a-z]+|[a-z]+|[0-9]+|[A-Za-z0-9_.-]+\.[A-Za-z0-9]+/g) ?? []) {
      const lw = w.toLowerCase();
      if (lw.length >= 3 && !STOP.has(lw)) out.push(lw);
    }
  }
  return out;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p: any) => {
      if (typeof p === "string") return p;
      if (p?.type === "text") return p.text ?? "";
      if (p?.type === "tool-call") return JSON.stringify(p.input ?? p.args ?? {});
      if (p?.type === "tool-result") {
        const raw = typeof p.output === "string" ? p.output : p.output?.value ?? p.result ?? "";
        return typeof raw === "string" ? raw : JSON.stringify(raw);
      }
      return "";
    }).join(" ");
  }
  return "";
}

function archiveText(a: CompactionArchive): string {
  const raw = a.messages.map((m: ModelMessage) => `${m.role}: ${messageText((m as any).content)}`).join("\n");
  return [a.instruction, a.summary, raw].filter(Boolean).join("\n");
}

function bestExcerpt(text: string, queryTerms: string[]): string | undefined {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return undefined;
  const scored = lines
    .map((line) => {
      const low = line.toLowerCase();
      let score = queryTerms.reduce((s, t) => s + (low.includes(t) ? 1 : 0), 0);
      if (/\b[\w./-]+\.[A-Za-z0-9]+\b/.test(line)) score += 0.5;
      if (/\b(bun|npm|pnpm|yarn|pytest|cargo|go test)\b/.test(low)) score += 0.5;
      return { line, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return undefined;
  let out = "";
  for (const { line } of scored.slice(0, 6)) {
    const next = out ? `${out}\n${line}` : line;
    if (next.length > MAX_EXCERPT_CHARS) break;
    out = next;
  }
  return out || undefined;
}

export function retrieveArchives(
  query: string,
  archives: CompactionArchive[] = [],
  k = 3,
  budget = 4_000,
  modelId?: string,
): RetrievedArchive[] {
  const qt = terms(query);
  if (!qt.length || !archives.length || budget <= 0) return [];
  const scored = archives.map((archive) => {
    const text = archiveText(archive);
    const low = text.toLowerCase();
    const title = archive.instruction || `turns ${archive.turns.start}-${archive.turns.end}`;
    const summary = archive.summary || "Earlier compacted turns are available in this archive.";
    let score = 0;
    for (const t of qt) {
      const hits = low.split(t).length - 1;
      if (hits) score += Math.min(4, hits);
      if (title.toLowerCase().includes(t)) score += 3;
      if ((archive.summary ?? "").toLowerCase().includes(t)) score += 2;
    }
    const graphEvidence = memoryGraphArchiveEvidence(qt, archive);
    score += Math.min(8, graphEvidence.reduce((s, e) => s + e.weight, 0));
    const provenance = graphEvidence.map((p) => p.label);
    return { archive, title, summary, text, provenance, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.archive.at - a.archive.at)
    .slice(0, k);

  const out: RetrievedArchive[] = [];
  let used = 0;
  for (const hit of scored) {
    const summary = hit.summary.slice(0, MAX_SUMMARY_CHARS);
    const excerpt = hit.score >= 4 ? bestExcerpt(hit.text, qt) : undefined;
    const provenance = hit.provenance.slice(0, 5);
    const body = [`Archive ${hit.archive.id}: ${hit.title}`, provenance.join("\n"), summary, excerpt].filter(Boolean).join("\n");
    const tokens = countTokens(body, modelId);
    if (used + tokens > budget) continue;
    out.push({ archiveId: hit.archive.id, title: hit.title, summary, excerpt, provenance, score: hit.score, tokens });
    used += tokens;
  }
  return out;
}
