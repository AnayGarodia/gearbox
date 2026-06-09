import React from "react";
import { Box, Text } from "ink";
import { color, glyph } from "../theme.ts";

function windowed<T>(items: T[], selected: number, limit: number): { rows: T[]; start: number } {
  const count = Math.max(1, limit);
  const safeSelected = Math.max(0, Math.min(selected, Math.max(items.length - 1, 0)));
  const maxStart = Math.max(0, items.length - count);
  const start = Math.min(Math.max(0, safeSelected - Math.floor(count / 2)), maxStart);
  return { rows: items.slice(start, start + count), start };
}

// File matches for an active @mention. The first row (highlighted) is what Tab completes.
export function FilePalette({ matches, selected = 0, limit = 5, width = 80 }: { matches: string[]; selected?: number; limit?: number; width?: number }) {
  const shown = windowed(matches, selected, limit);
  const rowWidth = Math.max(20, width - 2);
  if (shown.rows.length === 0) return null;
  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Text color={color.faint}>@ files · tab to complete</Text>
      {shown.rows.map((f, i) => {
        const active = shown.start + i === selected;
        const raw = `${active ? `${glyph.select} ` : "  "}${f}`;
        const text = raw.length > rowWidth ? raw.slice(0, Math.max(0, rowWidth - 1)) + "…" : raw.padEnd(rowWidth);
        return (
          <Text key={f} color={active ? color.text : color.faint} bold={active} backgroundColor={active ? color.accentBg : undefined}>{text}</Text>
        );
      })}
    </Box>
  );
}
