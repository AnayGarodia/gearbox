import React from "react";
import { Box, Text } from "ink";
import { color, glyph } from "../theme.ts";

const SEP = `  ${glyph.bullet}  `; // separator (5 cols)

// Session cost for the footer-right. Shown only once it rounds to a visible cent;
// a subscription seat estimates to $0, so the field simply disappears (the model
// label stands alone on the right). Never prints a fabricated number.
export function formatStatusCost(cost: number): string {
  return cost >= 0.005 ? `$${cost.toFixed(2)}` : "";
}

// Drop the lowest-priority fields until a joined line fits `budget` cols. Kept as a
// named export (and unit-tested) for reuse; the StatusBar itself now budgets the
// left legend directly. fields[0] is never dropped; survivors keep order. Pure.
export function fitStatusFields<T extends { text: string; priority: number }>(fields: T[], budget: number): T[] {
  const w = (fs: T[]) => fs.reduce((n, f) => n + f.text.length, 0) + Math.max(0, fs.length - 1) * SEP.length;
  const kept = fields.slice();
  while (kept.length > 1 && w(kept) > budget) {
    let dropIdx = -1;
    let lowest = Infinity;
    for (let i = 1; i < kept.length; i++) if (kept[i]!.priority < lowest) { lowest = kept[i]!.priority; dropIdx = i; }
    if (dropIdx < 0) break;
    kept.splice(dropIdx, 1);
  }
  return kept;
}

export type StatusZone = [start: number, end: number]; // 0-based, half-open cols

// Where the clickable MODEL label sits, in 0-based terminal columns. The footer is
// now KEYS LEFT, MODEL + COST RIGHT, so the model lives in the right segment which
// is right-aligned to the 1-col right padding: the right text is
// `<model>` (+ `  ·  $cost`), so it starts at width − 1 − rightLen and the model is
// its leading run. Single source of truth · the render and the mouse hit-test both
// derive from this so they cannot drift.
export function statusBarLayout({
  model,
  costText,
  width,
}: {
  model: string;
  costText?: string;
  width: number;
}): { modelZone: StatusZone } {
  const rightLen = model.length + (costText ? SEP.length + costText.length : 0);
  const start = Math.max(0, width - 1 - rightLen); // 1 = right paddingX
  return { modelZone: [start, start + model.length] };
}

// Resolve a fullscreen SGR mouse click (1-based x/y) to the model label, or null.
// The status-bar row is measured up from the composer pinned to the bottom:
// composer = marginTop(1) + rule(1) + policy(1) + input(N) → 3 chrome rows above
// the input; the palette box sits between the status bar and the composer. Pure so
// the fragile row math is testable. (Effort is no longer a clickable label — it is
// set via /effort and shift+tab; the footer redesign dropped that hit zone.)
export function statusBarHit(args: {
  x: number;
  y: number;
  termRows: number;
  composerLines: number;
  paletteRows: number;
  model: string;
  costText?: string;
  width: number;
  hasPolicy?: boolean; // policy row above the input (default true; hidden during onboarding)
  hintRows?: number; // a hint row below the input (e.g. bash "↵ runs in your shell"); default 0
}): "model" | null {
  // Composer chrome above the input: marginTop + rule [+ policy]. The optional hint
  // row sits BELOW the input, so it adds to the rows under the status bar. Coupled to
  // App.tsx's footer estimate and Composer.tsx's layout · keep in sync.
  const chrome = 3 + (args.hasPolicy === false ? 0 : 1); // marginTop + rule + marginBottom [+ policy]
  const statusRow = args.termRows - args.composerLines - (args.hintRows ?? 0) - args.paletteRows - chrome;
  if (args.y !== statusRow || !args.model) return null;
  const { modelZone } = statusBarLayout(args);
  const col = args.x - 1; // SGR x is 1-based; zones are 0-based
  if (col >= modelZone[0] && col < modelZone[1]) return "model";
  return null;
}

// Bottom status line, full width. Left: a quiet key legend + rare attention chips
// (offline / yolo / low-context). Right: the live model + the session cost. The
// per-turn routing provenance line in the transcript carries the routing reason, so
// the footer stays calm. A blank row above keeps the composer from crowding it.
export function StatusBar({
  model,
  cost = 0,
  ctxPct,
  yolo,
  width,
  online = true,
}: {
  model: string;
  cost?: number;
  ctxPct: number | null;
  yolo?: boolean;
  width: number;
  online?: boolean;
}) {
  const costText = formatStatusCost(cost);
  const right = costText ? `${model}${SEP}${costText}` : model;

  // Attention chips: scarce, meaningful, spent only where they change what you do.
  // Context shows ONLY when remaining is low (≤15% left ⇒ ctxPct ≥ 85), in amber.
  const lowCtx = ctxPct != null && ctxPct >= 85;
  const chips: { text: string; c: string; bold?: boolean }[] = [];
  if (!online) chips.push({ text: "⚠ offline", c: color.err, bold: true });
  if (yolo) chips.push({ text: "yolo", c: color.err, bold: true });
  if (lowCtx) chips.push({ text: `${Math.max(0, 100 - ctxPct!)}% ctx left`, c: color.warn }); // REMAINING, matching the working-strip notice
  const chipLen = chips.reduce((n, c) => n + c.text.length, 0) + Math.max(0, chips.length - 1) * 2 + (chips.length ? 2 : 0);

  // Budget the left so the right (model + cost) stays whole and right-aligned — the
  // click hit-test depends on that exact alignment. Truncate the legend to fit.
  const legend = `/ commands${SEP}@ files${SEP}↵ send${SEP}esc`;
  const leftBudget = Math.max(0, width - 2 /*paddingX*/ - right.length - 2 /*gap*/);
  const legendRoom = Math.max(0, leftBudget - chipLen);
  const legendShown =
    legend.length <= legendRoom ? legend : legendRoom > 1 ? legend.slice(0, legendRoom - 1) + "…" : "";

  return (
    <Box width={width} paddingX={1} marginTop={1} justifyContent="space-between">
      <Text wrap="truncate-end">
        {chips.map((c, i) => (
          <Text key={c.text} color={c.c} bold={c.bold}>{i > 0 ? "  " : ""}{c.text}</Text>
        ))}
        {chips.length && legendShown ? <Text color={color.faint}>{"  "}</Text> : null}
        <Text color={color.faint}>{legendShown}</Text>
      </Text>
      <Text wrap="truncate-end">
        <Text color={color.dim}>{model}</Text>
        {costText ? <Text color={color.faint}>{SEP + costText}</Text> : null}
      </Text>
    </Box>
  );
}
