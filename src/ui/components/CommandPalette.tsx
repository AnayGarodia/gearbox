import React from "react";
import { Box, Text } from "ink";
import { color } from "../theme.ts";
import { matchCommands } from "../../commands.ts";

/** Live command hints, shown while the input starts with "/". */
export function CommandPalette({ draft }: { draft: string }) {
  const matches = matchCommands(draft);
  if (matches.length === 0) return null;
  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      {matches.map((c) => (
        <Box key={c.name}>
          <Text color={color.accentDim}>{c.usage.padEnd(16)}</Text>
          <Text color={color.faint}>{c.desc}</Text>
        </Box>
      ))}
    </Box>
  );
}
