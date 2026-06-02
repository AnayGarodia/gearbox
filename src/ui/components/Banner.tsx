import React from "react";
import { Box, Text, useStdout } from "ink";
import { color, glyph } from "../theme.ts";

export function Banner({ model, width }: { model: string; width?: number }) {
  const { stdout } = useStdout();
  const w = width ?? Math.min(stdout?.columns ?? 80, 84);
  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Box>
        <Text color={color.accent}>{glyph.gear}  </Text>
        <Text color={color.accent} bold>
          gearbox
        </Text>
      </Box>
      <Text color={color.dim}>
        {"   "}coding harness {glyph.bullet} {model}
      </Text>
      <Text color={color.faint}>{glyph.rule.repeat(Math.max(w - 2, 8))}</Text>
    </Box>
  );
}
