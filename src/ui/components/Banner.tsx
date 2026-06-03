import React from "react";
import { Box, Text, useStdout } from "ink";
import { color, glyph } from "../theme.ts";

// Title bar: wordmark left, context (model · cwd) right, a hairline rule under.
export function Banner({ model, cwd, width }: { model: string; cwd?: string; width?: number }) {
  const { stdout } = useStdout();
  const w = width ?? Math.min(stdout?.columns ?? 80, 100);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box width={w} paddingX={1} justifyContent="space-between">
        <Text color={color.accent} bold>
          gearbox
        </Text>
        <Text color={color.dim}>
          {model}
          {cwd ? `  ${glyph.bullet}  ${cwd}` : ""}
        </Text>
      </Box>
      <Box paddingX={1}>
        <Text color={color.faint}>{glyph.rule.repeat(Math.max(w - 2, 8))}</Text>
      </Box>
    </Box>
  );
}
