import React from "react";
import { Box, Text } from "ink";
import { color } from "../theme.ts";

export const TABS = ["session", "routing", "providers", "cost"] as const;
export type AppTab = (typeof TABS)[number];
const LABELS: Record<AppTab, string> = { session: "Session", routing: "Routing", providers: "Providers", cost: "Cost" };

const GAP = 2; // spaces between tab labels

// Where each tab label sits, in 0-based terminal columns (after the 1-col left
// pad). Single source of truth for both the render and the click hit-test.
export function tabStripLayout(): Array<{ tab: AppTab; start: number; end: number }> {
  let col = 1; // paddingX
  const zones: Array<{ tab: AppTab; start: number; end: number }> = [];
  for (const t of TABS) {
    const len = LABELS[t].length;
    zones.push({ tab: t, start: col, end: col + len });
    col += len + GAP;
  }
  return zones;
}

// Resolve a fullscreen SGR click (1-based x/y) to a tab, or null. The strip sits
// on a fixed row just under the Banner (passed as stripRow, 1-based). Pure.
export function tabStripHit(x: number, y: number, stripRow: number): AppTab | null {
  if (y !== stripRow) return null;
  const col = x - 1; // SGR x is 1-based; zones are 0-based
  for (const z of tabStripLayout()) if (col >= z.start && col < z.end) return z.tab;
  return null;
}

// The top tab strip (fullscreen only): Session · Routing · Providers · Cost, the
// active one in the accent. One row, rendered just under the Banner.
export function TabStrip({ active, width }: { active: AppTab; width: number }) {
  return (
    <Box paddingX={1} width={width}>
      {TABS.map((t, i) => (
        <React.Fragment key={t}>
          {i > 0 ? <Text color={color.faint}>{" ".repeat(GAP)}</Text> : null}
          <Text color={t === active ? color.accent : color.dim} bold={t === active}>
            {LABELS[t]}
          </Text>
        </React.Fragment>
      ))}
    </Box>
  );
}
