// Subsequence fuzzy matching (à la fzf/Claude Code pickers): every character of
// the query must appear in the target in order. Scoring rewards contiguous runs
// and matches at word/path boundaries, and lightly prefers shorter targets, so
// "uithm" ranks src/ui/theme.ts and "mod" ranks /model. Lower score = better.
// Pure + unit-tested.

const BOUNDARY = /[/_\-. ]/;

/** Match score for `query` in `target` (lower = better), or null if no match. */
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 0;
  let qi = 0;
  let score = 0;
  let last = -1;
  let run = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    if (last >= 0) score += ti - last - 1; // gap penalty
    const prev = ti > 0 ? t[ti - 1]! : "/";
    if (ti === 0 || BOUNDARY.test(prev)) score -= 2; // boundary bonus
    run = last === ti - 1 ? run + 1 : 0;
    score -= run; // contiguity bonus
    last = ti;
    qi++;
  }
  if (qi < q.length) return null;
  return score + (t.length - last) * 0.1 + t.length * 0.01;
}

/** Rank `items` by fuzzy match of `query` against `key(item)`; drops non-matches. */
export function fuzzyRank<T>(items: T[], query: string, key: (t: T) => string, limit = 8): T[] {
  if (!query) return items.slice(0, limit);
  const scored: { item: T; s: number }[] = [];
  for (const it of items) {
    const s = fuzzyScore(query, key(it));
    if (s != null) scored.push({ item: it, s });
  }
  scored.sort((a, b) => a.s - b.s);
  return scored.slice(0, limit).map((x) => x.item);
}
