import React from "react";
import { Box } from "ink";
import { color } from "../theme.ts";
import { matchCommands } from "../../commands.ts";
import { ListRow } from "./ui.tsx";

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

/** Live command hints, shown while the input starts with "/". One ListRow per
 * command: label column padded to 16, description truncated to fit, the
 * selected row carrying the single accent-highlighted background. */
export function CommandPalette({ draft, selected = 0, limit = 5, rows, width = 80 }: { draft: string; selected?: number; limit?: number; rows?: PaletteRow[]; width?: number }) {
  const rowWidth = Math.max(20, width - 2);
  const list: PaletteRow[] = rows?.length
    ? rows
    : matchCommands(draft).map((c) => ({ value: c.name, label: c.usage, detail: c.desc }));
  if (list.length === 0) return null;
  const shown = windowed(list, selected, limit);
  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      {shown.rows.map((r, i) => {
        const active = shown.start + i === selected;
        return (
          <ListRow
            key={r.value}
            selected={active}
            label={r.label.padEnd(16)}
            labelColor={active ? color.text : color.dim}
            detail={r.detail}
            detailColor={active ? color.dim : color.faint}
            width={rowWidth}
          />
        );
      })}
    </Box>
  );
}
