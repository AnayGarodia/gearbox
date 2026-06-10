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
// composer = marginTop(1) + input(N) + footer hint(1) + marginBottom(1) → 3 chrome
// rows around the input; the palette box sits between the status bar and the
// composer. Pure so the fragile row math is testable. (Effort is no longer a
// clickable label — it is set via /effort and shift+tab.)
export function statusBarHit(args: {
  x: number;
  y: number;
  termRows: number;
  composerLines: number;
  paletteRows: number;
  model: string;
  costText?: string;
  width: number;
}): "model" | null {
  // Composer chrome around the input: marginTop above, the footer hint line +
  // marginBottom below. Coupled to App.tsx's footer estimate and Composer.tsx's
  // row-count contract · keep in sync.
  const chrome = 3; // marginTop + footer hint + marginBottom
  const statusRow = args.termRows - args.composerLines - args.paletteRows - chrome;
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
// Collapse $HOME to ~ and middle-truncate a long path so the bar never crowds.
export function collapsePath(p: string, max = 32): string {
  const home = process.env.HOME ?? "";
  let s = home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
  if (s.length > max) {
    const parts = s.split("/");
    while (parts.length > 3 && parts.join("/").length > max) parts.splice(1, 1);
    s = parts.length < s.split("/").length ? [parts[0], "…", ...parts.slice(1)].join("/") : s;
    if (s.length > max) s = "…" + s.slice(s.length - max + 1);
  }
  return s;
}

export function StatusBar({
  model,
  cost = 0,
  ctxPct,
  yolo,
  width,
  online = true,
  cwd,
  branch,
}: {
  model: string;
  cost?: number;
  ctxPct: number | null;
  yolo?: boolean;
  width: number;
  online?: boolean;
  cwd?: string;
  branch?: string | null;
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

  // Left: a quiet wordmark chip + cwd:branch (the opencode bar). Budgeted so the
  // right (model + cost) stays whole and right-aligned — the click hit-test
  // depends on that exact alignment.
  const where = cwd ? collapsePath(cwd) + (branch ? `:${branch}` : "") : "";
  const leftBudget = Math.max(0, width - 2 /*paddingX*/ - right.length - 2 /*gap*/);
  const whereRoom = Math.max(0, leftBudget - chipLen - " gearbox ".length - 1);
  const whereShown = where.length <= whereRoom ? where : whereRoom > 1 ? where.slice(0, whereRoom - 1) + "…" : "";

  return (
    <Box width={width} paddingX={1} marginTop={1} justifyContent="space-between">
      <Text wrap="truncate-end">
        <Text color={color.accent} bold backgroundColor={color.elementBg}>{" gearbox "}</Text>
        {whereShown ? <Text color={color.faint}>{" " + whereShown}</Text> : null}
        {chips.length ? <Text>{"  "}</Text> : null}
        {chips.map((c, i) => (
          <Text key={c.text} color={c.c} bold={c.bold}>{i > 0 ? "  " : ""}{c.text}</Text>
        ))}
      </Text>
      <Text wrap="truncate-end">
        <Text color={color.text}>{model}</Text>
        {costText ? <Text color={color.faint}>{SEP + costText}</Text> : null}
      </Text>
    </Box>
  );
}
