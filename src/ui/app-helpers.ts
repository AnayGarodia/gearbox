import type { ModelMessage } from "ai";
import { basename, extname, relative, resolve } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { RetrievalUseMeta } from "../session.ts";
import type { Backend } from "../model/selector.ts";
import { isNetworkError } from "./net.ts";
import { spawnSyncProc } from "../proc.ts";

/** Pure, stateless helpers lifted out of App.tsx. Kept free of React and of
 *  App's component state so they can be unit-tested in isolation. */

export function friendlyError(msg: string): string {
  if (isNetworkError(msg)) return `can't reach the provider · you appear to be offline · check your connection, then /retry`;
  return msg;
}

export function firstPath(text: string): string | null {
  const m = text.match(/(?:^|\s)([./~\w-][^\s:]*\.[\w-]+)(?:\s|$)/);
  return m?.[1] ?? null;
}

export function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

// Human-readable turn duration: sub-minute gets one decimal (4.2s); a minute or
// more is m s (1m 23s); sub-second rounds up to 0.1s so it never reads "0.0s".
export function formatDuration(ms: number): string {
  const s = ms / 1000;
  // Sub-minute: one decimal (4.2s) — unless it rounds up to 60.0s, then carry.
  const oneDecimal = Math.max(0.1, Math.round(s * 10) / 10);
  if (oneDecimal < 60) return `${oneDecimal.toFixed(1)}s`;
  // A minute or more: round to whole seconds FIRST, then split — so the seconds
  // can never round to 60 and read "1m 60s" (119.6s → 120 → "2m 0s").
  const total = Math.round(s);
  const m = Math.floor(total / 60);
  return `${m}m ${total % 60}s`;
}

export type CliModelChoice = { id: string; label: string; provider: string; efforts?: string[] };

// Claude CLI has no --thinking-effort flag · effort is not passed through.
export const CLAUDE_CLI_EFFORTS: string[] = [];
export const FALLBACK_CODEX_MODELS: CliModelChoice[] = [
  { id: "gpt-5.5", label: "gpt-5.5", provider: "codex", efforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.4", label: "gpt-5.4", provider: "codex", efforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.4-mini", label: "gpt-5.4-mini", provider: "codex", efforts: ["low", "medium", "high", "xhigh"] },
];

// The (backend kind, account) identity of a routing pick — the unit the
// API↔seat switch notice compares across turns.
export const backendKeyOf = (b: Backend | undefined): { kind: string; accountId?: string } => ({
  kind: b?.kind ?? "in-loop",
  accountId: b && "account" in b ? b.account?.id : undefined,
});

// A short, human category for a failover narration ("sonnet rate-limited → …").
export function shortFailure(message: string): string {
  const m = (message || "").toLowerCase();
  if (/\b402\b|credit|payment|billing|out of credit/.test(m)) return "out of credit";
  if (/over(loaded|capacity)|\b529\b/.test(m)) return "overloaded";
  if (/usage.?limit/.test(m)) return "at its usage limit";
  if (/quota|insufficient_quota/.test(m)) return "out of quota";
  if (/expired|session (?:has )?ended|not logged in|re-?authenticat/.test(m)) return "expired";
  if (/\b401\b|invalid|unauthorized|authentication/.test(m)) return "auth failed";
  return "rate-limited";
}

let codexModelCache: CliModelChoice[] | null = null;

export function codexCliModels(): CliModelChoice[] {
  if (codexModelCache) return codexModelCache;
  try {
    const r = spawnSyncProc(["codex", "debug", "models"], { stdout: "pipe", stderr: "ignore" });
    if (r.exitCode === 0) {
      const text = new TextDecoder().decode(r.stdout);
      const parsed = JSON.parse(text) as { models?: Array<{ slug?: string; visibility?: string; supported_reasoning_levels?: Array<{ effort?: string }> }> };
      const models = (parsed.models ?? [])
        .filter((m) => m.slug && m.visibility !== "hide")
        .map((m) => ({ id: m.slug!, label: m.slug!, provider: "codex", efforts: (m.supported_reasoning_levels ?? []).map((e) => e.effort).filter(Boolean) as string[] }));
      if (models.length) {
        codexModelCache = models;
        return models;
      }
    }
  } catch {
    /* fall back to the bundled Codex catalog below */
  }
  codexModelCache = FALLBACK_CODEX_MODELS;
  return codexModelCache;
}

export function effortDescription(level: string): string {
  return ({
    none: "no extra reasoning",
    minimal: "minimal reasoning",
    low: "lighter reasoning",
    medium: "default reasoning",
    high: "deeper reasoning",
    xhigh: "extra-high reasoning",
    max: "maximum reasoning",
  } as Record<string, string>)[level] ?? "reasoning effort";
}

export function previewLang(path: string): string {
  const ext = extname(path).slice(1).toLowerCase();
  return ({ tsx: "tsx", ts: "ts", jsx: "jsx", js: "js", py: "py", css: "css", json: "json", md: "md", sh: "sh" } as Record<string, string>)[ext] ?? ext;
}

export function filePreview(path: string): { text: string; lines: number; lang: string } | null {
  try {
    if (!path || !existsSync(path)) return null;
    const st = statSync(path);
    if (!st.isFile() || st.size > 400_000) return null;
    const raw = readFileSync(path, "utf8").replace(/\r\n?/g, "\n");
    const lines = raw.split("\n");
    return { text: raw, lines: lines.length, lang: previewLang(path) };
  } catch {
    return null;
  }
}

export function isWriteLikeTool(name: string): boolean {
  const n = name.toLowerCase();
  return n === "write_file" || n === "edit_file" || n === "write" || n === "edit" || n === "file_change";
}

export function retrievalUseMeta(
  retrieved: { file: string; pointer: boolean }[],
  produced: ModelMessage[],
  cwd: string,
): RetrievalUseMeta | undefined {
  const injected = [...new Set(retrieved.filter((r) => !r.pointer).map((r) => r.file))];
  if (!injected.length) return undefined;
  const touched = new Set<string>();
  const norm = (p: string): string => relative(cwd, resolve(cwd, p)).replace(/\\/g, "/");
  let prose = "";
  for (const m of produced) {
    const content = (m as any).content;
    if (m.role !== "assistant") continue;
    if (typeof content === "string") { prose += "\n" + content; continue; }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === "text") prose += "\n" + (part.text ?? "");
      if (part?.type !== "tool-call") continue;
      const input = part.input ?? part.args ?? {};
      const raw = input.path ?? input.file;
      if (typeof raw === "string" && raw) touched.add(norm(raw));
    }
  }
  // Used = touched by a tool, OR cited in the answer. The model often answers
  // FROM injected content without re-reading the file — counting that as
  // "unused" would sink exactly the injections that worked best.
  const used = injected.filter((f) => touched.has(norm(f)) || prose.includes(f) || prose.includes(basename(f)));
  const unused = injected.filter((f) => !touched.has(norm(f)));
  return { injected, used, unused };
}
