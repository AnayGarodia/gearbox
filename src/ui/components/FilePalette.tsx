import React from "react";
import { Box, Text } from "ink";
import { color, glyph } from "../theme.ts";

// File matches for an active @mention. The first row (highlighted) is what Tab completes.
export function FilePalette({ matches }: { matches: string[] }) {
  if (matches.length === 0) return null;
  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Text color={color.faint}>@ files · tab to complete</Text>
      {matches.map((f, i) => (
        <Box key={f}>
          <Text color={i === 0 ? color.accent : color.faint}>{i === 0 ? `${glyph.on} ` : "  "}</Text>
          <Text color={i === 0 ? color.accentDim : color.faint}>{f}</Text>
        </Box>
      ))}
    </Box>
  );
}
