import React from "react";
import { Box, Text } from "ink";
import { color, glyph } from "../theme.ts";
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

/** Split a row into the command part (primary) and the description part
 * (secondary) so each can be coloured independently, then pad to fill the row's
 * background. The description is truncated first when the row is too narrow. */
function rowParts(marker: string, label: string, detail: string | undefined, width: number): { cmd: string; det: string; pad: string } {
  // Clamp the command column too — a long usage string (e.g. "/checkpoint
  // [name|list|restore|rm]") must truncate, not wrap the row and break the
  // palette's row budget.
  let cmd = `${marker}${label.padEnd(16)}`;
  if (cmd.length > width) cmd = cmd.slice(0, Math.max(1, width - 1)) + "…";
  let det = detail ? "  " + detail : "";
  if (cmd.length + det.length > width) {
    const room = Math.max(0, width - cmd.length);
    det = room > 1 ? det.slice(0, room - 1) + "…" : "";
  }
  const pad = " ".repeat(Math.max(0, width - cmd.length - det.length));
  return { cmd, det, pad };
}

/** One palette row: command in primary text, description in secondary, with the
 * selected row carrying the single accent-highlighted background. */
function Row({ active, marker, label, detail, width }: { active: boolean; marker: string; label: string; detail?: string; width: number }) {
  const { cmd, det, pad } = rowParts(marker, label, detail, width);
  return (
    <Text backgroundColor={active ? color.accentBg : undefined}>
      <Text color={active ? color.text : color.dim} bold={active}>{cmd}</Text>
      <Text color={active ? color.dim : color.faint}>{det}</Text>
      {pad}
    </Text>
  );
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
          return <Row key={r.value} active={active} marker={active ? `${glyph.select} ` : "  "} label={r.label} detail={r.detail} width={rowWidth} />;
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
        return <Row key={c.name} active={active} marker={active ? `${glyph.select} ` : "  "} label={c.usage} detail={c.desc} width={rowWidth} />;
      })}
    </Box>
  );
}
