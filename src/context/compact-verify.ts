// Deterministic compaction verification. The model may summarize creatively, but
// mandatory anchors (files, commands, failures, constraints) must survive.
import type { ModelMessage } from "ai";
import type { CompactionVerification } from "../session.ts";

const FILE_RE = /\b[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|c|h|cpp|hpp|json|md|ya?ml|css|html|sh)\b/g;
const COMMAND_RE = /\b(?:bun|npm|pnpm|yarn|pytest|cargo|go test|tsc|eslint|vitest|jest)\b[^\n]*/g;
const FAILURE_RE = /\b(?:fail(?:ed|ing)?|error|exception|panic|red|not ok)\b[^\n]*/i;
// Strong imperatives only: "should/requires" fired on ordinary prose and
// bloated the patch with sentences that aren't constraints at all.
const CONSTRAINT_RE = /\b(?:must|never|always|do not|don't)\b/i;

function textOf(content: unknown): string {
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
    }).join("\n");
  }
  return "";
}

const uniq = (xs: string[]): string[] => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
const has = (haystack: string, needle: string): boolean => haystack.toLowerCase().includes(needle.toLowerCase());

export interface CompactionAnchors {
  files: string[];
  commands: string[];
  failures: string[];
  constraints: string[];
}

export function collectCompactionAnchors(messages: ModelMessage[]): CompactionAnchors {
  const files: string[] = [];
  const commands: string[] = [];
  const failures: string[] = [];
  const constraints: string[] = [];
  for (const m of messages) {
    const content = (m as any).content;
    if (Array.isArray(content)) {
      for (const p of content) {
        if (p?.type === "tool-call") {
          const input = p.input ?? p.args ?? {};
          const file = input.path ?? input.file;
          if (typeof file === "string") files.push(file);
          if (p.toolName === "run_shell" && typeof input.command === "string") commands.push(input.command);
        }
      }
    }
    const text = textOf(content);
    files.push(...(text.match(FILE_RE) ?? []));
    // Cap command anchors: COMMAND_RE runs to end-of-line, and a command
    // mentioned mid-paragraph (one long line) would otherwise anchor the WHOLE
    // line — the patch then re-embeds it and compaction can't shrink at all.
    commands.push(...(text.match(COMMAND_RE) ?? []).map((c) => c.slice(0, 120)));
    for (const line of text.split("\n").map((l) => l.trim())) {
      if (FAILURE_RE.test(line)) failures.push(line.slice(0, 180));
      // Constraints: USER lines with a strong imperative, short enough to be a
      // rule rather than a paragraph that merely contains one.
      if (m.role === "user" && CONSTRAINT_RE.test(line) && line.length <= 160) constraints.push(line);
    }
  }
  return {
    files: uniq(files).slice(0, 40),
    commands: uniq(commands).slice(0, 20),
    failures: uniq(failures).slice(0, 20),
    constraints: uniq(constraints).slice(0, 20),
  };
}

export function verifyCompactionSummary(summaryText: string, oldMessages: ModelMessage[]): CompactionVerification {
  const anchors = collectCompactionAnchors(oldMessages);
  const missingFiles = anchors.files.filter((f) => !has(summaryText, f));
  const missingCommands = anchors.commands.filter((c) => !has(summaryText, c));
  const missingFailures = anchors.failures.filter((f) => !has(summaryText, f));
  const missingConstraints = anchors.constraints.filter((c) => !has(summaryText, c));
  // The patch must never re-inflate the summary it exists to protect: each
  // category is capped (files are cheap and matter most; prose lines less so),
  // with an honest "+N more" marker instead of silent truncation.
  const capped = (xs: string[], n: number): string => xs.length <= n ? xs.join(" | ") : `${xs.slice(0, n).join(" | ")} (+${xs.length - n} more)`;
  const patch: string[] = [];
  if (missingFiles.length) patch.push(`Files preserved from compacted turns: ${missingFiles.slice(0, 20).join(", ")}${missingFiles.length > 20 ? ` (+${missingFiles.length - 20} more)` : ""}`);
  if (missingCommands.length) patch.push(`Commands/results preserved from compacted turns: ${capped(missingCommands, 8)}`);
  if (missingFailures.length) patch.push(`Failures/errors preserved from compacted turns: ${capped(missingFailures, 8)}`);
  if (missingConstraints.length) patch.push(`User constraints preserved from compacted turns: ${capped(missingConstraints, 6)}`);
  return {
    ok: patch.length === 0,
    missingFiles,
    missingCommands,
    missingFailures,
    missingConstraints,
    patch,
  };
}

export function applyVerificationPatch(summaryText: string, verification: CompactionVerification): string {
  if (!verification.patch.length) return summaryText;
  return `${summaryText.trim()}\n\nVerification patch:\n${verification.patch.map((p) => `- ${p}`).join("\n")}`;
}
