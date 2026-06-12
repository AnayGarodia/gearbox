export interface Item {
  name: string;
  score: number;
}

/** Returns the top N items by score (highest first). */
export function topN(items: Item[], n: number): Item[] {
  return items.sort((a, b) => b.score - a.score).slice(0, n);
}
