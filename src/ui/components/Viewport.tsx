import React from "react";
import { Box, Text } from "ink";
import { color } from "../theme.ts";
import type { Line } from "../lines.ts";

function LineRow({ line }: { line: Line }) {
  if (line.length === 0) return <Text> </Text>; // a blank row still occupies one line
  return (
    <Text>
      {line.map((s, j) => (
        <Text key={j} color={s.color} bold={s.bold} italic={s.italic} dimColor={s.dim} backgroundColor={s.bg}>
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

// The scroll region: shows exactly `height` rows from the line buffer starting at
// `scrollTop`, padded so the chrome below stays pinned, with a scrollbar on the
// right. Rendering a fixed line count is what keeps the frame from ever exceeding
// the screen (the cause of the earlier corruption).
export function Viewport({ lines, scrollTop, height, width }: { lines: Line[]; scrollTop: number; height: number; width: number }) {
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
          <LineRow key={i} line={l} />
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
