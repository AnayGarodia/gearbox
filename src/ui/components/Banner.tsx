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
        {/* Cap + truncate the account so a long one can't wrap/overflow next to the
            wordmark on a narrow terminal (T-G — same class as the status-bar fix). */}
        {account ? <Text color={color.faint} wrap="truncate-end">{account.slice(0, Math.max(0, w - 12))}</Text> : null}
      </Box>
      <Box paddingX={1}>
        <Text color={color.faint}>{glyph.rule.repeat(Math.max(w - 2, 8))}</Text>
      </Box>
    </Box>
  );
}
