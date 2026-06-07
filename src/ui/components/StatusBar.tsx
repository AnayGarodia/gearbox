import React from "react";
import { Box, Text } from "ink";
import { color, glyph } from "../theme.ts";

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

const SEP = `  ${glyph.bullet}  `; // separator between left-segment fields (5 cols)

export type StatusZone = [start: number, end: number]; // 0-based, half-open cols

// Pure layout helper: where the clickable model/effort labels sit in the status
// bar's left segment, in 0-based terminal columns. Single source of truth · the
// StatusBar render and the mouse hit-test both derive from this so the rendered
// position and the clickable position cannot drift. Mirrors the render:
// paddingX(1) + optional "{mode}{SEP}" + model + optional "{SEP}effort {effort}".
export function statusBarLayout({
  model,
  effort,
  mode = "normal",
}: {
  model: string;
  effort?: string;
  mode?: "normal" | "auto-accept" | "plan";
}): { modelZone: StatusZone; effortZone: StatusZone | null } {
  const modeLabel = mode === "auto-accept" ? "auto-accept" : mode;
  const modelStart = 1 + (mode !== "normal" ? modeLabel.length + SEP.length : 0);
  const modelZone: StatusZone = [modelStart, modelStart + model.length];
  if (!effort) return { modelZone, effortZone: null };
  const effortText = `effort ${effort}`;
  const effortStart = modelZone[1] + SEP.length;
  return { modelZone, effortZone: [effortStart, effortStart + effortText.length] };
}

// Resolve a fullscreen SGR mouse click (1-based x/y) to the model/effort label,
// or null. The status-bar row is measured up from the composer, which is pinned
// to the bottom of the screen: composer = marginTop(1) + rule(1) + input(N), the
// input's bottom line is the last terminal row, and the palette box sits between
// the status bar and the composer. Pure so the fragile row math is testable.
export function statusBarHit(args: {
  x: number;
  y: number;
  termRows: number;
  composerLines: number;
  paletteRows: number;
  model: string;
  effort?: string;
  mode?: "normal" | "auto-accept" | "plan";
}): "model" | "effort" | null {
  // The `- 2` is the composer chrome above its input (rule + marginTop). It is
  // coupled to App.tsx's footer estimate (`footer += perm ? 9 : 3`, the 3 being
  // input + those same 2 chrome rows) and to Composer.tsx's layout · keep in sync.
  const statusRow = args.termRows - args.composerLines - args.paletteRows - 2;
  if (args.y !== statusRow || !args.model) return null;
  const { modelZone, effortZone } = statusBarLayout(args);
  const col = args.x - 1; // SGR x is 1-based; zones are 0-based
  if (col >= modelZone[0] && col < modelZone[1]) return "model";
  if (effortZone && col >= effortZone[0] && col < effortZone[1]) return "effort";
  return null;
}

// Bottom status line, full width. Left: model, branch, ctx, tokens (no "gearbox"
// brand · the title bar already says it). Right: the routing pick · the product's
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
  effort,
  subscription = null,
  online = true,
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
  effort?: string;
  subscription?: string | null; // active CLI-backed subscription account label
  online?: boolean;
}) {
  const sep = SEP;
  const modeLabel = mode === "auto-accept" ? "auto-accept" : mode; // "plan" / "auto-accept"
  const left = [
    model,
    effort ? `effort ${effort}` : null,
    branch ? `${glyph.branch} ${branch}` : null,
    tokens > 0 ? `${fmtTokens(tokens)} tok` : null,
    cost >= 0.005 ? `$${cost.toFixed(2)}` : null,
  ].filter(Boolean) as string[];
  const ctxColor = ctxPct == null || ctxPct < 70 ? color.faint : ctxPct < 90 ? color.accent : color.err;

  return (
    <Box width={width} paddingX={1} marginTop={1} justifyContent="space-between">
      <Text color={color.dim} wrap="truncate-end">
        {mode !== "normal" ? <Text color={color.accent}>{modeLabel}{sep}</Text> : null}
        {left.length ? <Text color={color.dim}>{left[0]}</Text> : null}
        {left.slice(1).map((x) => <Text key={x} color={x.includes("tok") ? color.accentDim : color.faint}>{sep}{x}</Text>)}
        {ctxPct != null && ctxPct > 0 ? <Text color={ctxColor}>{left.length ? sep : ""}{ctxPct}% ctx</Text> : null}
        {!online ? <Text color={color.err} bold>{sep}⚠ offline</Text> : null}
      </Text>
      <Text color={color.faint} wrap="truncate-end">
        {yolo ? <Text color={color.err} bold>yolo</Text> : null}
        {yolo && (subscription || routing) ? `  ${glyph.bullet}  ` : null}
        {/* Active subscription account takes over the right side (no in-loop routing).
            The model name is already on the left, so the right reminds you of the
            one thing that's different: it runs its own tools/permissions. */}
        {subscription ? <Text><Text color={color.ok}>subscription</Text><Text color={color.faint}> {glyph.bullet} </Text><Text color={color.text}>own tools/perms</Text></Text> : null}
        {/* Compact: just "auto · <kind>". The full reason (caps · $/Mtok) lives in
            the per-turn provenance line; repeating it here overflows the bar and
            forced both halves to truncate mid-token. */}
        {!subscription && routing ? <Text color={color.accentDim}>auto</Text> : null}
        {!subscription && routing ? ` ${glyph.bullet} ${routing.split(" · ")[0]}` : null}
      </Text>
    </Box>
  );
}
