// Pure text helpers.
//
// 1. Tool-output discipline (truncateOutput / spillOutput / capToolOutput):
//    tool results are capped BEFORE they enter model history — one read_file of
//    a 5000-line file must never eat a context window. The full output spills
//    to ~/.gearbox/tool-outputs/ and the truncation notice teaches the model
//    the recovery move (read_file with offset, or search).
//
// 2. Differentiating truncation: when several sibling strings
// share a long prefix (e.g. five delegate tasks that all start "You are doing a
// COMMENT CLEANUP PASS only — no logic in src/…"), truncating from the START makes
// them identical and impossible to tell apart. Instead, drop the shared prefix and
// show the part that VARIES (the target file/module), so each sibling is distinct.

import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Tool-output discipline ──────────────────────────────────────────────────

/** Default caps applied at tool-result ingestion. */
export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50_000;

export interface TruncateResult {
  text: string;
  truncated: boolean;
  totalLines: number;
  totalBytes: number;
}

export interface TruncateOpts {
  maxLines?: number;
  maxBytes?: number;
  /** "head" keeps the start (file reads); "tail" keeps the end (shell — the end of build/test output is what matters). */
  direction?: "head" | "tail";
  /** Where the full output was spilled, woven into the truncation notice so the model can recover. */
  spillPath?: string | null;
}

/**
 * Cap text at maxLines AND maxBytes (both enforced). When truncated, the
 * returned text carries a notice that names the visible range, the spill path
 * (if any), and the recovery move — so the model learns to page instead of
 * re-reading blind.
 */
export function truncateOutput(text: string, opts: TruncateOpts = {}): TruncateResult {
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const direction = opts.direction ?? "head";
  const totalBytes = Buffer.byteLength(text, "utf8");
  const lines = text.split("\n");
  const totalLines = lines.length;
  if (totalLines <= maxLines && totalBytes <= maxBytes) return { text, truncated: false, totalLines, totalBytes };

  // Line cap first, then drop whole lines from the cut side until under the byte budget.
  let kept = direction === "head" ? lines.slice(0, maxLines) : lines.slice(-maxLines);
  let bytes = Buffer.byteLength(kept.join("\n"), "utf8");
  while (kept.length > 1 && bytes > maxBytes) {
    const dropped = direction === "head" ? kept.pop()! : kept.shift()!;
    bytes -= Buffer.byteLength(dropped, "utf8") + 1; // +1 for the joining newline
  }
  let body = kept.join("\n");
  if (Buffer.byteLength(body, "utf8") > maxBytes) {
    // A single line bigger than the budget — hard-slice it.
    const buf = Buffer.from(body, "utf8");
    body = direction === "head" ? buf.subarray(0, maxBytes).toString("utf8") : buf.subarray(buf.length - maxBytes).toString("utf8");
  }
  const shown = kept.length;
  const spill = opts.spillPath ? ` Full output: ${opts.spillPath}.` : "";
  const out =
    direction === "head"
      ? `${body}\n[truncated: showing lines 1-${shown} of ${totalLines}.${spill} Use read_file with offset=${shown + 1}, or search to find specific content.]`
      : `[truncated: showing last ${shown} of ${totalLines} lines.${spill}]\n${body}`;
  return { text: out, truncated: true, totalLines, totalBytes };
}

const spillDir = () => join(process.env.GEARBOX_HOME || join(homedir(), ".gearbox"), "tool-outputs");

const DAY_MS = 24 * 60 * 60 * 1000;
let gcRan = false; // gc at most once per process, lazily on the first spill

/** Delete spill files older than maxAgeMs. Best-effort; never throws. */
export function gcSpills(maxAgeMs = 7 * DAY_MS): void {
  try {
    const dir = spillDir();
    const cutoff = Date.now() - maxAgeMs;
    for (const f of readdirSync(dir)) {
      try {
        const p = join(dir, f);
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
      } catch {
        /* skip unreadable */
      }
    }
  } catch {
    /* no dir yet — nothing to gc */
  }
}

/**
 * Write the FULL output of a truncated tool result to
 * ~/.gearbox/tool-outputs/<name>-<timestamp>-<rand>.txt (GEARBOX_HOME respected)
 * and return the path. Returns null on any error — spilling is best-effort and
 * must never fail the tool.
 */
export function spillOutput(name: string, full: string): string | null {
  try {
    const dir = spillDir();
    mkdirSync(dir, { recursive: true });
    if (!gcRan) {
      gcRan = true;
      gcSpills();
    }
    const slug = name.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 40) || "tool";
    const path = join(dir, `${slug}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    writeFileSync(path, full, "utf8");
    return path;
  } catch {
    return null;
  }
}

/**
 * The one-call helper tools use: truncate, and when truncation actually bit,
 * spill the full text to disk and weave the spill path into the notice.
 */
export function capToolOutput(name: string, text: string, opts: Omit<TruncateOpts, "spillPath"> = {}): string {
  const r = truncateOutput(text, opts);
  if (!r.truncated) return text;
  const spill = spillOutput(name, text);
  if (!spill) return r.text;
  // Single truncation pass: splice the spill path into the already-built notice
  // exactly where truncateOutput would have woven it (right after the counts).
  const insert = ` Full output: ${spill}.`;
  if ((opts.direction ?? "head") === "tail") {
    // Tail notice is the FIRST line, so the first " lines." belongs to it.
    const at = r.text.indexOf(" lines.");
    if (at !== -1) return r.text.slice(0, at + 7) + insert + r.text.slice(at + 7);
  } else {
    // Head notice is appended LAST; find its marker, then the "." after the counts.
    const mark = r.text.lastIndexOf("\n[truncated: showing lines 1-");
    const at = mark === -1 ? -1 : r.text.indexOf(".", mark);
    if (at !== -1) return r.text.slice(0, at + 1) + insert + r.text.slice(at + 1);
  }
  return r.text;
}

// ── Differentiating truncation ──────────────────────────────────────────────

export function longestCommonPrefixLen(strs: string[]): number {
  if (strs.length < 2) return 0;
  const a = strs[0]!;
  let n = a.length;
  for (let k = 1; k < strs.length; k++) {
    const b = strs[k]!;
    let i = 0;
    while (i < n && i < b.length && a[i] === b[i]) i++;
    n = i;
    if (n === 0) break;
  }
  return n;
}

// Word-boundary truncation with an ellipsis (mirrors delegate.ts clipTask).
function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  const cut = one.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return (at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,.;:`'"(–-]+$/, "") + "…";
}

// The distinguishing slice of strs[idx] vs its siblings, ≤ max chars. Falls back to
// a "#N" label when the strings are effectively identical (no distinguishing tail).
export function differentiatingSlice(strs: string[], idx: number, max: number): string {
  const s = (strs[idx] ?? "").replace(/\s+/g, " ").trim();
  if (strs.length < 2) return clip(s, max);
  const lcp = longestCommonPrefixLen(strs.map((x) => x.replace(/\s+/g, " ").trim()));
  if (lcp >= s.length - 1) return clip(s, max); // genuinely identical — show the task as-is
  // Back up to a word boundary so the slice doesn't begin mid-word.
  let start = lcp;
  const prevSpace = s.lastIndexOf(" ", start);
  if (prevSpace > 0 && start - prevSpace <= 16) start = prevSpace + 1;
  const tail = s.slice(start).trimStart();
  return tail ? clip(tail, max) : clip(s, max);
}
