// Pure edit-application core for the edit_file tool.
//
// Models routinely hand back a `find` block whose indentation or internal spacing
// drifts from the file (reflowed, re-indented, tabs↔spaces). Exact string replace
// then fails and burns a whole turn. So we try exact first (preserves intra-line
// detail), and only when that finds nothing do we fall back to a whitespace-
// tolerant LINE match: compare line sequences with each line trimmed and internal
// runs of whitespace collapsed, then splice the replacement over the original span.
//
// The fallback is line-granular on purpose — that is exactly what makes it robust
// to indentation drift — and it refuses to guess when the normalized block matches
// in more than one place (unless replaceAll / occurrence is given).

export interface EditOpts {
  occurrence?: number; // 1-based; which match to replace when replaceAll is false
  replaceAll?: boolean;
}

export type EditResult =
  | { ok: true; after: string; strategy: "exact" | "whitespace"; replacements: number }
  | { ok: false; reason: "not-found" | "ambiguous" | "out-of-range"; matches: number };

function countExact(text: string, find: string): number {
  if (!find) return 0;
  let n = 0;
  let at = 0;
  while ((at = text.indexOf(find, at)) >= 0) {
    n++;
    at += find.length;
  }
  return n;
}

function replaceExactNth(text: string, find: string, replace: string, occurrence: number): string {
  let at = -1;
  let from = 0;
  for (let i = 0; i < occurrence; i++) {
    at = text.indexOf(find, from);
    if (at < 0) return text;
    from = at + find.length;
  }
  return text.slice(0, at) + replace + text.slice(at + find.length);
}

// Collapse a line to its whitespace-insensitive signature: trim the ends and
// squeeze internal whitespace runs to a single space.
function norm(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}

// Find every starting line index in `lines` where the normalized `findLines`
// block matches.
function whitespaceMatches(lines: string[], findLines: string[]): number[] {
  const starts: number[] = [];
  const need = findLines.map(norm);
  const n = need.length;
  if (n === 0) return starts;
  for (let i = 0; i + n <= lines.length; i++) {
    let hit = true;
    for (let j = 0; j < n; j++) {
      if (norm(lines[i + j]!) !== need[j]) {
        hit = false;
        break;
      }
    }
    if (hit) starts.push(i);
  }
  return starts;
}

export function applyEdit(before: string, find: string, replace: string, opts: EditOpts): EditResult {
  const occurrence = opts.occurrence ?? 1;
  const replaceAll = opts.replaceAll ?? false;

  // 1. Exact path — preserves everything, including intra-line offsets.
  const exact = countExact(before, find);
  if (exact > 0) {
    if (!replaceAll && occurrence > exact) return { ok: false, reason: "out-of-range", matches: exact };
    const after = replaceAll ? before.split(find).join(replace) : replaceExactNth(before, find, replace, occurrence);
    return { ok: true, after, strategy: "exact", replacements: replaceAll ? exact : 1 };
  }

  // 2. Whitespace-tolerant line fallback.
  const lines = before.split("\n");
  const findLines = find.split("\n");
  const replaceLines = replace.split("\n");
  const starts = whitespaceMatches(lines, findLines);
  if (starts.length === 0) return { ok: false, reason: "not-found", matches: 0 };
  if (!replaceAll) {
    if (starts.length > 1 && occurrence === 1 && opts.occurrence === undefined) {
      // Ambiguous: the normalized block appears more than once and the caller did
      // not say which. Refuse rather than silently editing the wrong one.
      return { ok: false, reason: "ambiguous", matches: starts.length };
    }
    if (occurrence > starts.length) return { ok: false, reason: "out-of-range", matches: starts.length };
  }

  const span = findLines.length;
  const targets = replaceAll ? starts : [starts[occurrence - 1]!];
  // Splice from the bottom up so earlier indices stay valid.
  const out = lines.slice();
  for (const start of [...targets].sort((a, b) => b - a)) {
    out.splice(start, span, ...replaceLines);
  }
  return { ok: true, after: out.join("\n"), strategy: "whitespace", replacements: targets.length };
}
