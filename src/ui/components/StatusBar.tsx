import React from "react";
import { Box, Text } from "ink";
import { color, glyph } from "../theme.ts";
import { barCells } from "../../accounts/usage.ts";
import { limitColor } from "../severity.ts";

const SEP = `  ${glyph.bullet}  `; // separator (5 cols)

// The meter's context gauge: 5 bar cells + " ctx" — shown whenever a context %
// is known (limitColor carries the severity: green → amber → red as it fills).
const GAUGE_W = 5;
const GAUGE_LEN = GAUGE_W + 4; // "█████ ctx"

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

// Where the clickable MODEL label sits, in 0-based terminal columns. The meter is
// WHERE LEFT, MODEL + GAUGE + COST RIGHT, so the model lives in the right segment
// which is right-aligned to the 1-col right padding: the right text is
// `<model>` (+ `  ·  █████ ctx`) (+ `  ·  $cost`), so it starts at
// width − 1 − rightLen and the model is its leading run. Single source of truth ·
// the render and the mouse hit-test both derive from this so they cannot drift.
export function statusBarLayout({
  model,
  costText,
  ctxPct,
  width,
}: {
  model: string;
  costText?: string;
  ctxPct?: number | null;
  width: number;
}): { modelZone: StatusZone } {
  const rightLen =
    model.length +
    (ctxPct != null ? SEP.length + GAUGE_LEN : 0) +
    (costText ? SEP.length + costText.length : 0);
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
  composerLines: number; // kept for call-site compatibility; the meter no longer depends on it
  paletteRows: number;
  model: string;
  costText?: string;
  ctxPct?: number | null;
  width: number;
}): "model" | null {
  // The meter is the BOTTOM EDGE of the frame (App renders it last) — the row
  // math is simply "the last row". Lockstep with App.tsx footerJsx ordering.
  if (args.y !== args.termRows || !args.model) return null;
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
  // The context GAUGE: 5 cells, severity-colored, shown whenever a context % is
  // known. This replaces the old ≥85-only amber chip — the gauge IS the
  // low-context notice now (it turns amber/red via limitColor as it fills).
  const gauge = ctxPct != null ? barCells(Math.max(0, Math.min(100, ctxPct)) / 100, GAUGE_W) : null;
  const rightLen =
    model.length + (gauge ? SEP.length + GAUGE_LEN : 0) + (costText ? SEP.length + costText.length : 0);

  // Attention chips: scarce, meaningful, spent only where they change what you do.
  const chips: { text: string; c: string; bold?: boolean }[] = [];
  if (!online) chips.push({ text: "⚠ offline", c: color.err, bold: true });
  if (yolo) chips.push({ text: "yolo", c: color.err, bold: true });
  const chipLen = chips.reduce((n, c) => n + c.text.length, 0) + Math.max(0, chips.length - 1) * 2 + (chips.length ? 2 : 0);

  // Left: cwd:branch + the attention chips (the wordmark lives in the masthead
  // now). Budgeted so the right (model · gauge · cost) stays whole and
  // right-aligned — the click hit-test depends on that exact alignment.
  const where = cwd ? collapsePath(cwd) + (branch ? `:${branch}` : "") : "";
  const leftBudget = Math.max(0, width - 2 /*paddingX*/ - rightLen - 2 /*gap*/);
  const whereRoom = Math.max(0, leftBudget - chipLen);
  const whereShown = where.length <= whereRoom ? where : whereRoom > 1 ? where.slice(0, whereRoom - 1) + "…" : "";

  return (
    <Box width={width} paddingX={1} marginTop={1} justifyContent="space-between">
      <Text wrap="truncate-end">
        {whereShown ? <Text color={color.faint}>{whereShown}</Text> : null}
        {chips.length ? <Text>{"  "}</Text> : null}
        {chips.map((c, i) => (
          <Text key={c.text} color={c.c} bold={c.bold}>{i > 0 ? "  " : ""}{c.text}</Text>
        ))}
      </Text>
      <Text wrap="truncate-end">
        <Text color={color.text}>{model}</Text>
        {gauge ? (
          <>
            <Text color={color.faint}>{SEP}</Text>
            <Text color={limitColor(ctxPct!)}>{gauge.fill}</Text>
            <Text color={color.faint}>{gauge.empty + " ctx"}</Text>
          </>
        ) : null}
        {costText ? <Text color={color.faint}>{SEP + costText}</Text> : null}
      </Text>
    </Box>
  );
}
