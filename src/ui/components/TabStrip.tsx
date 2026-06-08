import React from "react";
import { Box, Text } from "ink";
import { color } from "../theme.ts";

export const TABS = ["session", "routing", "providers", "cost"] as const;
export type AppTab = (typeof TABS)[number];
const LABELS: Record<AppTab, string> = { session: "Session", routing: "Routing", providers: "Providers", cost: "Cost" };

const GAP = 1; // spaces between tab pills (the pills carry their own padding)
const PAD = 1; // leading + trailing space inside every pill, so the active fill reads as a chip

// Where each tab PILL sits, in 0-based terminal columns (after the 1-col left
// pad). Every tab carries the same ` Label ` padding regardless of active state,
// so these columns never shift when the selection changes — the click hit-test
// can stay a pure, active-independent function. The zone covers the whole pill
// (padding included) so a click anywhere on the chip registers. Single source of
// truth for both the render and the click hit-test.
export function tabStripLayout(): Array<{ tab: AppTab; start: number; end: number }> {
  let col = 1; // paddingX
  const zones: Array<{ tab: AppTab; start: number; end: number }> = [];
  for (const t of TABS) {
    const w = LABELS[t].length + PAD * 2;
    zones.push({ tab: t, start: col, end: col + w });
    col += w + GAP;
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

// The top tab strip (fullscreen only): Session · Routing · Providers · Cost. The
// active tab is a filled pill (dark text on the accent) so the strip reads as
// navigation, not content, and the current view is unmistakable; inactive tabs
// are quiet dim labels. One row, rendered just under the Banner. The ` Label `
// padding is present on every tab (invisible without a fill) so the columns —
// and the click zones — never move when the selection changes.
export function TabStrip({ active, width }: { active: AppTab; width: number }) {
  return (
    <Box paddingX={1} width={width}>
      {TABS.map((t, i) => {
        const on = t === active;
        return (
          <React.Fragment key={t}>
            {i > 0 ? <Text>{" ".repeat(GAP)}</Text> : null}
            <Text color={on ? color.navy : color.dim} backgroundColor={on ? color.accent : undefined} bold={on}>
              {" ".repeat(PAD) + LABELS[t] + " ".repeat(PAD)}
            </Text>
          </React.Fragment>
        );
      })}
    </Box>
  );
}
