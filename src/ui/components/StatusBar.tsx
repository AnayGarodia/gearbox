import React from "react";
import { Box, Text } from "ink";
import { color, glyph } from "../theme.ts";

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function StatusBar({
  model,
  cwd,
  branch,
  ctxPct,
  tokens,
  width,
}: {
  model: string;
  cwd: string;
  branch: string | null;
  ctxPct: number | null;
  tokens: number;
  width: number;
}) {
  const place = branch ? `${cwd} ⎇ ${branch}` : cwd;
  const parts = [
    model,
    ctxPct != null && ctxPct > 0 ? `${ctxPct}% ctx` : null,
    tokens > 0 ? `${fmtTokens(tokens)} tok` : null,
    place,
  ].filter(Boolean) as string[];

  return (
    <Box width={width} paddingX={1}>
      <Text color={color.faint} wrap="truncate-end">
        {parts.join(`  ${glyph.bullet}  `)}
      </Text>
    </Box>
  );
}
