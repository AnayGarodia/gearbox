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
