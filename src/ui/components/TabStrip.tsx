import React from "react";
import { Box, Text } from "ink";
import { color, glyph } from "../theme.ts";

export const TABS = ["session", "routing", "providers", "cost"] as const;
export type AppTab = (typeof TABS)[number];
const LABELS: Record<AppTab, string> = { session: "session", routing: "routing", providers: "providers", cost: "cost" };

const GAP = 1; // spaces between tab pills (the pills carry their own padding)
const PAD = 1; // leading + trailing space inside every pill, so the active fill reads as a chip

// The masthead (Broadsheet): ONE full-width chrome row — `gearbox` wordmark, the
// four tabs, the active account — with a hairline rule under. The tabs start
// after the wordmark + a 2-space gap; this column is the single source of truth
// for both the render and the click hit-test, so they cannot drift.
const WORDMARK = "gearbox";
export const MASTHEAD_TAB_COL = 1 /* paddingX */ + WORDMARK.length + 2; // = 10

// Where each tab PILL sits, in 0-based terminal columns (after the wordmark).
// Every tab carries the same ` Label ` padding regardless of active state,
// so these columns never shift when the selection changes — the click hit-test
// can stay a pure, active-independent function. The zone covers the whole pill
// (padding included) so a click anywhere on the chip registers.
export function tabStripLayout(offset = MASTHEAD_TAB_COL): Array<{ tab: AppTab; start: number; end: number }> {
  let col = offset;
  const zones: Array<{ tab: AppTab; start: number; end: number }> = [];
  for (const t of TABS) {
    const w = LABELS[t].length + PAD * 2;
    zones.push({ tab: t, start: col, end: col + w });
    col += w + GAP;
  }
  return zones;
}

// Resolve a fullscreen SGR click (1-based x/y) to a tab, or null. The masthead
// row sits at a fixed row (passed as stripRow, 1-based: marginTop is row 1, the
// masthead row 2). Pure.
export function tabStripHit(x: number, y: number, stripRow: number, offset = MASTHEAD_TAB_COL): AppTab | null {
  if (y !== stripRow) return null;
  const col = x - 1; // SGR x is 1-based; zones are 0-based
  for (const z of tabStripLayout(offset)) if (col >= z.start && col < z.end) return z.tab;
  return null;
}

// The masthead (fullscreen only): wordmark (accent bold) · the four tabs (active
// = accent-bg pill, inactive dim) · the account label right (faint), one row,
// hairline rule under. Replaces the old separate Banner + TabStrip rows.
// Memoized: props are stable while scrolling/streaming. `epoch` exists solely so
// /theme invalidates the memo (setTheme mutates `color` in place).
function MastheadImpl({ active, account, width, showTabs = true }: { active: AppTab; account?: string | null; width: number; showTabs?: boolean; epoch?: number }) {
  // Account room: whatever the wordmark + tabs leave over (tabs ≈ 38 cols).
  const tabsLen = showTabs ? TABS.reduce((n, t) => n + LABELS[t].length + PAD * 2, 0) + GAP * (TABS.length - 1) : 0;
  const acctRoom = Math.max(0, width - MASTHEAD_TAB_COL - tabsLen - 4);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box width={width} paddingX={1} justifyContent="space-between">
        <Text wrap="truncate-end">
          <Text color={color.accent} bold>{WORDMARK}</Text>
          <Text>{"  "}</Text>
          {showTabs
            ? TABS.map((t, i) => {
                const on = t === active;
                return (
                  <React.Fragment key={t}>
                    {i > 0 ? <Text>{" ".repeat(GAP)}</Text> : null}
                    <Text color={on ? color.navy : color.dim} backgroundColor={on ? color.accent : undefined} bold={on}>
                      {" ".repeat(PAD) + LABELS[t] + " ".repeat(PAD)}
                    </Text>
                  </React.Fragment>
                );
              })
            : null}
        </Text>
        {account ? <Text color={color.faint} wrap="truncate-end">{account.slice(0, acctRoom)}</Text> : null}
      </Box>
      <Box paddingX={1}>
        <Text color={color.faint}>{glyph.rule.repeat(Math.max(width - 2, 8))}</Text>
      </Box>
    </Box>
  );
}

export const Masthead = React.memo(MastheadImpl);
