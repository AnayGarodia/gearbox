import React from "react";
import { Box, Text } from "ink";
import { color } from "../theme.ts";
import type { Line } from "../lines.ts";

export type ViewSelection = { startLine: number; startCol: number; endLine: number; endCol: number };

function normalized(sel?: ViewSelection | null): ViewSelection | null {
  if (!sel) return null;
  const aBeforeB = sel.startLine < sel.endLine || (sel.startLine === sel.endLine && sel.startCol <= sel.endCol);
  return aBeforeB ? sel : { startLine: sel.endLine, startCol: sel.endCol, endLine: sel.startLine, endCol: sel.startCol };
}

function selectedRangeForLine(sel: ViewSelection | null, absLine: number): [number, number] | null {
  if (!sel || absLine < sel.startLine || absLine > sel.endLine) return null;
  const start = absLine === sel.startLine ? sel.startCol : 0;
  const end = absLine === sel.endLine ? sel.endCol : Number.POSITIVE_INFINITY;
  if (end <= start) return null;
  return [start, end];
}

function LineRow({ line, absLine, selection }: { line: Line; absLine: number; selection?: ViewSelection | null }) {
  if (line.length === 0) return <Text> </Text>; // a blank row still occupies one line
  const range = selectedRangeForLine(normalized(selection), absLine);
  let pos = 0;
  return (
    <Text>
      {line.flatMap((s, j) => {
        const start = pos;
        const end = pos + s.text.length;
        pos = end;
        if (!range || end <= range[0] || start >= range[1]) {
          return [
            <Text key={j} color={s.color} bold={s.bold} italic={s.italic} dimColor={s.dim} backgroundColor={s.bg}>
              {s.text}
            </Text>,
          ];
        }
        const a = Math.max(range[0] - start, 0);
        const b = Math.min(range[1] - start, s.text.length);
        return [
          s.text.slice(0, a) ? <Text key={`${j}-a`} color={s.color} bold={s.bold} italic={s.italic} dimColor={s.dim} backgroundColor={s.bg}>{s.text.slice(0, a)}</Text> : null,
          <Text key={`${j}-b`} inverse>{s.text.slice(a, b)}</Text>,
          s.text.slice(b) ? <Text key={`${j}-c`} color={s.color} bold={s.bold} italic={s.italic} dimColor={s.dim} backgroundColor={s.bg}>{s.text.slice(b)}</Text> : null,
        ].filter(Boolean);
      })}
    </Text>
  );
}

// The scroll region: shows exactly `height` rows from the line buffer starting at
// `scrollTop`, padded so the chrome below stays pinned, with a scrollbar on the
// right. Rendering a fixed line count is what keeps the frame from ever exceeding
// the screen (the cause of the earlier corruption).
export function Viewport({ lines, scrollTop, height, width, selection }: { lines: Line[]; scrollTop: number; height: number; width: number; selection?: ViewSelection | null }) {
  const visible = lines.slice(scrollTop, scrollTop + height);
  const padded: Line[] = visible.slice();
  while (padded.length < height) padded.push([]);

  const total = lines.length;
  const hasBar = total > height;
  const thumb = hasBar ? Math.max(1, Math.round((height / total) * height)) : 0;
  const maxTop = Math.max(1, total - height);
  const thumbStart = hasBar ? Math.min(height - thumb, Math.round((scrollTop / maxTop) * (height - thumb))) : 0;

  return (
    <Box width={width}>
      <Box flexDirection="column" width={width - 1}>
        {padded.map((l, i) => (
          <LineRow key={i} line={l} absLine={scrollTop + i} selection={selection} />
        ))}
      </Box>
      <Box flexDirection="column" width={1}>
        {Array.from({ length: height }, (_, i) => {
          const on = hasBar && i >= thumbStart && i < thumbStart + thumb;
          return (
            <Text key={i} color={on ? color.accentDim : color.faint}>
              {on ? "┃" : hasBar ? "│" : " "}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}
