import React from "react";
import { Box, Text } from "ink";
import { color } from "../theme.ts";
import { matchCommands } from "../../commands.ts";

export interface PaletteRow {
  value: string;
  label: string;
  detail?: string;
}

function windowed<T>(items: T[], selected: number, limit: number): { rows: T[]; start: number } {
  const count = Math.max(1, limit);
  const safeSelected = Math.max(0, Math.min(selected, Math.max(items.length - 1, 0)));
  const maxStart = Math.max(0, items.length - count);
  const start = Math.min(Math.max(0, safeSelected - Math.floor(count / 2)), maxStart);
  return { rows: items.slice(start, start + count), start };
}

/** Live command hints, shown while the input starts with "/". */
function rowText(marker: string, label: string, detail: string | undefined, width: number): string {
  const raw = `${marker}${label.padEnd(16)}${detail ? "  " + detail : ""}`;
  if (raw.length > width) return raw.slice(0, Math.max(0, width - 1)) + "…";
  return raw.padEnd(width);
}

/** Live command hints, shown while the input starts with "/". */
export function CommandPalette({ draft, selected = 0, limit = 5, rows, width = 80 }: { draft: string; selected?: number; limit?: number; rows?: PaletteRow[]; width?: number }) {
  const rowWidth = Math.max(20, width - 2);
  if (rows?.length) {
    const shown = windowed(rows, selected, limit);
    return (
      <Box flexDirection="column" paddingX={1} marginTop={1}>
        {shown.rows.map((r, i) => {
          const active = shown.start + i === selected;
          return (
            <Text key={r.value} color={active ? color.text : color.dim} bold={active} backgroundColor={active ? color.accentBg : undefined}>
              {rowText(active ? "● " : "  ", r.label, r.detail, rowWidth)}
            </Text>
          );
        })}
      </Box>
    );
  }
  const matches = matchCommands(draft);
  if (matches.length === 0) return null;
  const shown = windowed(matches, selected, limit);
  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      {shown.rows.map((c, i) => {
        const active = shown.start + i === selected;
        return (
          <Text key={c.name} color={active ? color.text : color.dim} bold={active} backgroundColor={active ? color.accentBg : undefined}>
            {rowText(active ? "● " : "  ", c.usage, c.desc, rowWidth)}
          </Text>
        );
      })}
    </Box>
  );
}
