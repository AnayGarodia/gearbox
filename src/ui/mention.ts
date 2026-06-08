// Pure logic for @file mentions in the composer. Tested without a terminal.
import { fuzzyRank } from "./fuzzy.ts";

export interface Mention {
  token: string; // text after '@' up to the cursor
  start: number; // index of '@'
  end: number; // cursor
}

/** The @word ending at the cursor, or null. */
export function currentMention(value: string, cursor: number): Mention | null {
  let start = cursor;
  while (start > 0 && !/\s/.test(value[start - 1]!)) start--;
  const word = value.slice(start, cursor);
  if (!word.startsWith("@")) return null;
  return { token: word.slice(1), start, end: cursor };
}

/** Files containing the token, ranked by match position then path length. */
export function matchFiles(files: string[], token: string, limit = 8): string[] {
  const q = token.toLowerCase();
  if (!q) return files.slice(0, limit);
  // Exact substring matches first (ranked by position, then length). Fall back to
  // fuzzy subsequence (e.g. "uistatus" matches src/ui/components/StatusBar.tsx).
  const sub = files
    .filter((f) => f.toLowerCase().includes(q))
    .sort((a, b) => {
      const ai = a.toLowerCase().indexOf(q);
      const bi = b.toLowerCase().indexOf(q);
      return ai - bi || a.length - b.length;
    });
  if (sub.length) return sub.slice(0, limit);
  return fuzzyRank(files, token, (f) => f, limit);
}

/** Replace the mention token with the chosen path + a trailing space. */
export function completeMention(value: string, mention: Mention, path: string): { value: string; cursor: number } {
  const before = value.slice(0, mention.start);
  const after = value.slice(mention.end);
  const insert = `@${path} `;
  return { value: before + insert + after, cursor: (before + insert).length };
}
