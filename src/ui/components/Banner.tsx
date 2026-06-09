import React from "react";
import { Box, Text, useStdout } from "ink";
import { color, glyph } from "../theme.ts";

// Title bar: wordmark left, the active account right (or nothing), a hairline
// rule under. Live model/provider state lives in the bottom status bar (one
// canonical home); the working dir lives in /context. The right corner is the
// account so it never echoes the wordmark (the project dir is literally
// "gearbox", which read as the wordmark twice).
// Memoized: props (account, width) are stable while scrolling/streaming, so the
// title bar skips those re-renders (it only changes on account switch or resize).
// `epoch` exists solely so /theme invalidates the memo — without it the banner
// kept the old palette until a resize (setTheme mutates `color` in place).
function BannerImpl({ account, width }: { model?: string; account?: string | null; width?: number; epoch?: number }) {
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

export const Banner = React.memo(BannerImpl);
