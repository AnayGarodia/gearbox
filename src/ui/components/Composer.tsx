import React from "react";
import { Box, Text } from "ink";
import { color, glyph } from "../theme.ts";
import { caretPos } from "../input.ts";

// Borderless composer: a hairline rule, then a `❯` prompt with the input and a
// terminal-native block cursor (`inverse`). Multi-line aware — continuation lines
// align under the prompt and the cursor lands on the right row/column. No box.
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
  const lines = value.split("\n");
  const { lineIdx: curLine, col: curCol } = caretPos(value, cursor);
  const prefix = (i: number) => (i === 0 ? glyph.prompt + " " : "  ");

  return (
    <Box flexDirection="column" width={width} marginTop={1}>
      <Box paddingX={1}>
        <Text color={color.faint}>{glyph.rule.repeat(Math.max(width - 2, 8))}</Text>
      </Box>
      {busy ? (
        <Box paddingX={1}>
          <Text color={color.faint} bold>
            {glyph.prompt}{" "}
          </Text>
          <Text color={color.faint}>{value || "…"}</Text>
        </Box>
      ) : value === "" ? (
        <Box paddingX={1}>
          <Text color={color.accent} bold>
            {glyph.prompt}{" "}
          </Text>
          <Text inverse> </Text>
          <Text color={color.faint}>{placeholder}</Text>
        </Box>
      ) : (
        <Box flexDirection="column" paddingX={1}>
          {lines.map((ln, i) => (
            <Box key={i}>
              <Text color={color.accent} bold>{prefix(i)}</Text>
              {i === curLine ? (
                <Text>
                  {ln.slice(0, curCol)}
                  <Text inverse>{ln[curCol] ?? " "}</Text>
                  {ln.slice(curCol + 1)}
                </Text>
              ) : (
                <Text>{ln}</Text>
              )}
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
