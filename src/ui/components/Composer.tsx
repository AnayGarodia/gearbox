import React from "react";
import { Box, Text } from "ink";
import { color, glyph } from "../theme.ts";

// Display-only. Key handling lives in App (useInput + the pure applyKey reducer).
// Renders a terminal-native block cursor via `inverse`.
export function Composer({
  value,
  cursor,
  placeholder,
  busy,
  width,
}: {
  value: string;
  cursor: number;
  placeholder: string;
  busy: boolean;
  width: number;
}) {
  return (
    <Box width={width} paddingX={1} marginTop={1} borderStyle="round" borderColor={busy ? color.faint : color.accentDim}>
      <Text color={color.accent}>{glyph.prompt} </Text>
      {busy ? (
        <Text color={color.dim}>working… esc to interrupt</Text>
      ) : value === "" ? (
        <Text>
          <Text inverse> </Text>
          <Text color={color.faint}>{placeholder}</Text>
        </Text>
      ) : (
        <Text>
          {value.slice(0, cursor)}
          <Text inverse>{value[cursor] ?? " "}</Text>
          {value.slice(cursor + 1)}
        </Text>
      )}
    </Box>
  );
}
