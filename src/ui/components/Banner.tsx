import React from "react";
import { Box, Text, useStdout } from "ink";
import { color, glyph } from "../theme.ts";

// Title bar: wordmark left, the active account right (or nothing), a hairline
// rule under. Live model/provider state lives in the bottom status bar (one
// canonical home); the working dir lives in /context. The right corner is the
// account so it never echoes the wordmark (the project dir is literally
// "gearbox", which read as the wordmark twice).
export function Banner({ account, width }: { model?: string; account?: string | null; width?: number }) {
  const { stdout } = useStdout();
  const w = width ?? Math.min(stdout?.columns ?? 80, 100);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box width={w} paddingX={1} justifyContent="space-between">
        <Text color={color.accent} bold>
          gearbox
        </Text>
        {account ? <Text color={color.faint}>{account}</Text> : null}
      </Box>
      <Box paddingX={1}>
        <Text color={color.faint}>{glyph.rule.repeat(Math.max(w - 2, 8))}</Text>
      </Box>
    </Box>
  );
}
