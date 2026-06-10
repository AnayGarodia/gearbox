import React from "react";
import { Box, Text } from "ink";
import { color, glyph } from "../theme.ts";

// The masthead (Broadsheet): ONE full-width chrome row — the `gearbox` wordmark
// left, the active account right — with a hairline rule under. The tab pills
// that used to live here are gone: their facts already had homes (per-turn
// model · $ in the margin, /why for routing, /account for providers, /cost for
// the money story), so the tabs were duplicate dashboards.
const WORDMARK = "gearbox";

// Memoized: props are stable while scrolling/streaming. `epoch` exists solely so
// /theme invalidates the memo (setTheme mutates `color` in place).
function MastheadImpl({ account, width }: { account?: string | null; width: number; epoch?: number }) {
  const acctRoom = Math.max(0, width - WORDMARK.length - 4);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box width={width} paddingX={1} justifyContent="space-between">
        <Text color={color.accent} bold>{WORDMARK}</Text>
        {account ? <Text color={color.faint} wrap="truncate-end">{account.slice(0, acctRoom)}</Text> : null}
      </Box>
      <Box paddingX={1}>
        <Text color={color.faint}>{glyph.rule.repeat(Math.max(width - 2, 8))}</Text>
      </Box>
    </Box>
  );
}

export const Masthead = React.memo(MastheadImpl);
