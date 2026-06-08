// Pure text helpers. Differentiating truncation: when several sibling strings
// share a long prefix (e.g. five delegate tasks that all start "You are doing a
// COMMENT CLEANUP PASS only — no logic in src/…"), truncating from the START makes
// them identical and impossible to tell apart. Instead, drop the shared prefix and
// show the part that VARIES (the target file/module), so each sibling is distinct.

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
