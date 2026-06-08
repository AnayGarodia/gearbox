/**
 * Minimal change-view utilities for displaying file diffs in the UI.
 *
 * This module does NOT produce the standard unified-diff format (no @@
 * hunk headers, no context lines). It deliberately omits unchanged context
 * lines so the terminal view stays compact: only added and removed lines
 * are kept. Callers that need a full unified diff (e.g. patch files) should
 * use the `diff` package directly.
 *
 * Typical call sequence:
 *   1. computeDiff(before, after) to get the line-level change list.
 *   2. diffStat(lines) to render the "+N -M" summary in the status bar.
 *   3. Iterate over the DiffLine array to render coloured lines in the UI.
 */
import { diffLines } from "diff";

/**
 * A single changed line, tagged with its direction.
 * `sign` is "+" for an added line, "-" for a removed line.
 * `text` is the line content without a trailing newline.
 */
export type DiffLine = { sign: "+" | "-"; text: string };

/**
 * Computes the line-level difference between two strings.
 *
 * Uses the Myers diff algorithm (via the `diff` package) to find the minimal
 * edit set. Only changed lines are included in the output: unchanged context
 * lines are stripped so the result is suitable for a compact terminal view,
 * not a full patch file.
 *
 * Each input line appears at most once in the output, tagged "+" (present in
 * `after` but not `before`) or "-" (present in `before` but not `after`).
 * Trailing newlines are removed from each line before it is stored.
 *
 * @param before - Original file content (or empty string for a new file).
 * @param after  - Updated file content (or empty string for a deleted file).
 * @returns Array of changed lines in diff order, additions and deletions interleaved.
 */
export function computeDiff(before: string, after: string): DiffLine[] {
  const out: DiffLine[] = [];
  for (const part of diffLines(before, after)) {
    if (!part.added && !part.removed) continue; // skip unchanged context
    const sign: "+" | "-" = part.added ? "+" : "-";
    for (const line of part.value.replace(/\n$/, "").split("\n")) out.push({ sign, text: line });
  }
  return out;
}

/**
 * Formats a compact "+N -M" summary string from a DiffLine array.
 *
 * Intended for status-bar display alongside the file name, e.g. "+3 -1".
 * Uses a Unicode minus sign ("−") for the deletion count to visually
 * distinguish it from a hyphen in filenames.
 *
 * @param lines - Output of computeDiff.
 * @returns A string of the form "+<additions> −<deletions>".
 */
export function diffStat(lines: DiffLine[]): string {
  const add = lines.filter((l) => l.sign === "+").length;
  const del = lines.filter((l) => l.sign === "-").length;
  return `+${add} −${del}`;
}
