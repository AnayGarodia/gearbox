// Compact change view: only the added/removed lines (no context noise).
import { diffLines } from "diff";

export type DiffLine = { sign: "+" | "-"; text: string };

export function computeDiff(before: string, after: string): DiffLine[] {
  const out: DiffLine[] = [];
  for (const part of diffLines(before, after)) {
    if (!part.added && !part.removed) continue; // skip unchanged context
    const sign: "+" | "-" = part.added ? "+" : "-";
    for (const line of part.value.replace(/\n$/, "").split("\n")) out.push({ sign, text: line });
  }
  return out;
}

export function diffStat(lines: DiffLine[]): string {
  const add = lines.filter((l) => l.sign === "+").length;
  const del = lines.filter((l) => l.sign === "-").length;
  return `+${add} −${del}`;
}
