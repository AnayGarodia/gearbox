import React from "react";
import { Box, Text } from "ink";
import { color, glyph } from "../theme.ts";
import { tabBarSegments, type TabRow } from "../tabbar.ts";

// The masthead (Broadsheet): ONE full-width chrome row — the `gearbox` wordmark
// left, the active account right — with a hairline rule under. With the
// conductor mounted (tabRows), the row also carries the CLICKABLE session tabs
// (` 1 main  2 fix●  + `): click a tab to switch, click + for a new parallel
// session in its own worktree. (The OLD info pills were removed as duplicate
// dashboards; these are interactive session handles, a different thing.)
// Layout comes from the pure tabBarSegments so App's mouse hit-test (the same
// function) can never disagree with the rendered pixels.
const WORDMARK = "gearbox";
/** 0-based column where the tab cells start: paddingX(1) + wordmark + 2 gap.
 *  App's click handler MUST hit-test with the same constant (exported). */
export const TABBAR_LEFT = 1 + WORDMARK.length + 2;
/** 1-based terminal row the masthead text sits on (marginTop pushes it to 2). */
export const MASTHEAD_ROW = 2;

/** Where the CLICKABLE account name sits on the masthead row (0-based,
 *  half-open cols), or null when it isn't rendered. Mirrors the render below
 *  exactly: right-aligned to the 1-col padding, shown only when the tab bar
 *  leaves it ≥ 8 cols of room. Clicking it opens /account. */
export function mastheadAccountZone(account: string | null | undefined, tabRows: TabRow[] | null | undefined, width: number): [number, number] | null {
  if (!account || !tabRows?.length) return null;
  const segs = tabBarSegments(tabRows, TABBAR_LEFT, width - 1);
  const end = segs.length ? segs[segs.length - 1]!.x1 : TABBAR_LEFT;
  const room = Math.max(0, width - end - 4);
  if (room <= 8) return null;
  const shown = Math.min(account.length, room);
  return [width - 1 - shown, width - 1];
}

// Memoized: props are stable while scrolling/streaming. `epoch` exists solely so
// /theme invalidates the memo (setTheme mutates `color` in place).
function MastheadImpl({ account, width, tabRows }: { account?: string | null; width: number; epoch?: number; tabRows?: TabRow[] | null }) {
  if (tabRows?.length) {
    const segs = tabBarSegments(tabRows, TABBAR_LEFT, width - 1);
    const spans: React.ReactNode[] = [];
    let x = TABBAR_LEFT;
    for (const s of segs) {
      if (s.x0 > x) spans.push(<Text key={`g${s.x0}`}>{" ".repeat(s.x0 - x)}</Text>);
      const alert = s.row?.needsInput;
      const done = s.row?.done;
      spans.push(
        s.row ? (
          // The cell IS the notification (no toasts): finished-while-hidden
          // flips it green+bold+inverse until visited; blocked flips it red.
          <Text key={s.x0} bold={s.row.active || done || alert} inverse={s.row.active || done} color={alert ? color.err : done ? color.ok : s.row.active ? color.accent : color.faint}>
            {s.text}
          </Text>
        ) : (
          <Text key={s.x0} color={color.accent}>{s.text}</Text>
        ),
      );
      x = s.x1;
    }
    // Same math as mastheadAccountZone — render and click zone cannot drift.
    const acctRoom = Math.max(0, width - x - 4);
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box width={width} paddingX={1}>
          <Text color={color.accent} bold>{WORDMARK}</Text>
          <Text>{"  "}</Text>
          {spans}
          <Box flexGrow={1} justifyContent="flex-end">
            {account && acctRoom > 8 ? <Text color={color.faint} wrap="truncate-end">{account.slice(0, acctRoom)}</Text> : null}
          </Box>
        </Box>
        <Box paddingX={1}>
          <Text color={color.faint}>{glyph.rule.repeat(Math.max(width - 2, 8))}</Text>
        </Box>
      </Box>
    );
  }
  const acctRoom = Math.max(0, width - WORDMARK.length - 4);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box width={width} paddingX={1} justifyContent="space-between">
        <Text color={color.accent} bold>{WORDMARK}</Text>
        {account ? <Text color={color.faint} wrap="truncate-end">{account.slice(0, acctRoom)}</Text> : null}
      </Box>
      <Box paddingX={1}>
        <Text color={color.faint}>{glyph.rule.repeat(Math.max(width - 2, 8))}</Text>
      </Box>
    </Box>
  );
}

export const Masthead = React.memo(MastheadImpl);
