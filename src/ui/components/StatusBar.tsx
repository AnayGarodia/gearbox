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
  cost = 0,
  width,
  mode = "normal",
  effort = "balanced",
  subscription = null,
}: {
  model: string;
  cwd?: string;
  branch: string | null;
  routing?: string | null;
  yolo?: boolean;
  ctxPct: number | null;
  tokens: number;
  cost?: number;
  width: number;
  mode?: "normal" | "auto-accept" | "plan";
  effort?: "fast" | "balanced" | "max";
  subscription?: string | null; // active CLI-backed subscription account label
}) {
  const sep = `  ${glyph.bullet}  `;
  const modeLabel = mode === "auto-accept" ? "auto-accept" : mode; // "plan" / "auto-accept"
  const left = [
    model,
    subscription ? null : `⚡${effort}`, // effort/reasoning doesn't apply on a CLI subscription
    branch ? `${glyph.branch} ${branch}` : null,
    ctxPct != null && ctxPct > 0 ? `${ctxPct}% ctx` : null,
    tokens > 0 ? `${fmtTokens(tokens)} tok` : null,
    cost >= 0.005 ? `$${cost.toFixed(2)}` : null,
  ].filter(Boolean) as string[];

  return (
    <Box width={width} paddingX={1} marginTop={1} justifyContent="space-between">
      <Text color={color.faint} wrap="truncate-end">
        {mode !== "normal" ? <Text color={color.accent}>{modeLabel}{sep}</Text> : null}
        {left.join(sep)}
      </Text>
      <Text color={color.faint} wrap="truncate-end">
        {yolo ? <Text color={color.err} bold>⚡ yolo</Text> : null}
        {yolo && (subscription || routing) ? `  ${glyph.bullet}  ` : null}
        {/* Active subscription account takes over the right side (no in-loop routing).
            The model name is already on the left, so the right reminds you of the
            one thing that's different: it runs its own tools/permissions. */}
        {subscription ? <Text color={color.accent}>subscription {glyph.bullet} own tools/perms</Text> : null}
        {!subscription && routing ? <Text color={color.accentDim}>auto</Text> : null}
        {!subscription && routing ? ` ${glyph.bullet} ${routing}` : null}
      </Text>
    </Box>
  );
}
