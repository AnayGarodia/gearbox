import React from "react";
import { Box, Text, useStdout } from "ink";
import { color, glyph } from "../theme.ts";

// Title bar: wordmark left, working dir right, a hairline rule under. Live
// model/provider state lives in the bottom status bar (one canonical home), so
// the top bar doesn't repeat it · it just says where you are.
export function Banner({ cwd, width }: { model?: string; cwd?: string; width?: number }) {
  const { stdout } = useStdout();
  const w = width ?? Math.min(stdout?.columns ?? 80, 100);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box width={w} paddingX={1} justifyContent="space-between">
        <Text color={color.accent} bold>
          gearbox
        </Text>
        {cwd ? <Text color={color.faint}>{cwd}</Text> : null}
      </Box>
      <Box paddingX={1}>
        <Text color={color.faint}>{glyph.rule.repeat(Math.max(w - 2, 8))}</Text>
      </Box>
    </Box>
  );
}
