import React from "react";
import { Box, Text } from "ink";
import { color, glyph } from "../theme.ts";

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// Bottom status line, full width. Left: model, branch, ctx, tokens (no "gearbox"
// brand — the title bar already says it). Right: the routing pick — the product's
// USP, where no other agent shows anything. A blank row above it keeps the
// composer from crowding the status.
export function StatusBar({
  model,
  branch,
  routing,
  yolo,
  ctxPct,
  tokens,
  width,
}: {
  model: string;
  cwd?: string;
  branch: string | null;
  routing?: string | null;
  yolo?: boolean;
  ctxPct: number | null;
  tokens: number;
  width: number;
}) {
  const sep = `  ${glyph.bullet}  `;
  const left = [
    model,
    branch ? `${glyph.branch} ${branch}` : null,
    ctxPct != null && ctxPct > 0 ? `${ctxPct}% ctx` : null,
    tokens > 0 ? `${fmtTokens(tokens)} tok` : null,
  ].filter(Boolean) as string[];

  return (
    <Box width={width} paddingX={1} marginTop={1} justifyContent="space-between">
      <Text color={color.faint} wrap="truncate-end">
        {left.join(sep)}
      </Text>
      <Text color={color.faint} wrap="truncate-end">
        {yolo ? <Text color={color.err} bold>⚡ yolo</Text> : null}
        {yolo && routing ? `  ${glyph.bullet}  ` : null}
        {routing ? <Text color={color.accentDim}>routing</Text> : null}
        {routing ? ` ${glyph.bullet} ${routing}` : null}
      </Text>
    </Box>
  );
}
