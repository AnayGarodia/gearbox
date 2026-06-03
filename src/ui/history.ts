// Shell-style prompt history navigation. Pure + tested.
// idx === null means "at the live (new) line, below the newest entry".
export function navHistory(
  history: string[],
  idx: number | null,
  dir: "up" | "down",
): { value: string; idx: number | null } {
  if (history.length === 0) return { value: "", idx };
  if (dir === "up") {
    const next = idx === null ? history.length - 1 : Math.max(0, idx - 1);
    return { value: history[next] ?? "", idx: next };
  }
  // down
  if (idx === null) return { value: "", idx: null };
  const next = idx + 1;
  if (next >= history.length) return { value: "", idx: null }; // back to the live line
  return { value: history[next] ?? "", idx: next };
}

// Reverse incremental search (⌃R): the idx-th most-recent history entry that
// contains `q` (case-insensitive). Returns null when there's no match.
export function searchHistory(history: string[], q: string, idx: number): string | null {
  if (!q) return null;
  const lq = q.toLowerCase();
  const matches: string[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i]!;
    if (h.toLowerCase().includes(lq)) matches.push(h);
  }
  if (!matches.length) return null;
  return matches[Math.min(idx, matches.length - 1)] ?? null;
}
