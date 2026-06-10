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
      if (s.row) {
        // Cell anatomy (widths owned by tabBarSegments — concatenates to s.text):
        // active = an accent pill (navy ink on accent bg, like the home pills);
        // inactive = dim number · text-ink title · status mark in its own color
        // (⚠ err when a hidden tab waits on consent · ● run-indigo while busy).
        const on = s.row.active;
        spans.push(
          <Text key={s.x0} backgroundColor={on ? color.accent : undefined} bold={on}>
            <Text color={on ? color.navy : color.faint}>{s.num}</Text>
            <Text color={on ? color.navy : alert ? color.err : color.dim}>{s.title}</Text>
            <Text color={on ? color.navy : alert ? color.err : color.run}>{s.mark}</Text>
            <Text color={on ? color.navy : color.dim}>{" "}</Text>
          </Text>,
        );
      } else {
        spans.push(<Text key={s.x0} color={color.accent} bold>{s.text}</Text>);
      }
      x = s.x1;
    }
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
