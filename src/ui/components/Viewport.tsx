import React from "react";
import { Box, Text } from "ink";
import { color } from "../theme.ts";
import { displayWidth } from "../width.ts";
import type { Line } from "../lines.ts";

export type ViewSelection = { startLine: number; startCol: number; endLine: number; endCol: number };

function normalized(sel?: ViewSelection | null): ViewSelection | null {
  if (!sel) return null;
  const aBeforeB = sel.startLine < sel.endLine || (sel.startLine === sel.endLine && sel.startCol <= sel.endCol);
  return aBeforeB ? sel : { startLine: sel.endLine, startCol: sel.endCol, endLine: sel.startLine, endCol: sel.startCol };
}

// The outer hull of two selection ranges — min(start) … max(end) compared by
// (line, col). Word/line-granular drag uses this: dragging out from a double- or
// triple-click always covers WHOLE words/lines on both sides of the anchor and
// never splits the one under the cursor. Pure + tested.
export function hullSelection(a: ViewSelection, b: ViewSelection): ViewSelection {
  const na = normalized(a)!;
  const nb = normalized(b)!;
  const beforeEq = (l1: number, c1: number, l2: number, c2: number) => l1 < l2 || (l1 === l2 && c1 <= c2);
  const start = beforeEq(na.startLine, na.startCol, nb.startLine, nb.startCol)
    ? { line: na.startLine, col: na.startCol }
    : { line: nb.startLine, col: nb.startCol };
  const end = beforeEq(na.endLine, na.endCol, nb.endLine, nb.endCol)
    ? { line: nb.endLine, col: nb.endCol }
    : { line: na.endLine, col: na.endCol };
  return { startLine: start.line, startCol: start.col, endLine: end.line, endCol: end.col };
}

function selectedRangeForLine(sel: ViewSelection | null, absLine: number): [number, number] | null {
  if (!sel || absLine < sel.startLine || absLine > sel.endLine) return null;
  const start = absLine === sel.startLine ? sel.startCol : 0;
  const end = absLine === sel.endLine ? sel.endCol : Number.POSITIVE_INFINITY;
  if (end <= start) return null;
  return [start, end];
}

// Memoized by line REFERENCE (the line buffer keeps stable refs for unchanged
// items via the WeakMap cache), so a re-render that didn't change a row's content
// (streaming the tail, a status tick, a paste landing) skips re-rendering every
// other row — a big cut in Ink reconciliation on a tall transcript.
const LineRow = React.memo(function LineRow({ line, range: rangeProp, lineWidth }: { line: Line; range: [number, number] | null; lineWidth: number }) {
  // No canvas color — let the terminal's own background show through. Only spans
  // with an explicit semantic bg (code block / your message / diff) are painted;
  // empty rows and trailing space stay transparent.
  if (line.length === 0) {
    return <Text>{" ".repeat(lineWidth)}</Text>;
  }
  let range = rangeProp;
  // Clamp the selection band to the line's INK: the centering margin and the
  // telemetry-margin padding are baked-in spaces, and painting them produced
  // ragged full-width bands. The band starts at the first ink column and stops
  // after the last (a span counts as ink if it has any non-space text or its
  // own background).
  if (range) {
    let pos = 0, first = -1, last = -1;
    for (const s of line) {
      const ink = s.bg != null || /\S/.test(s.text);
      if (ink) { if (first < 0) { const lead = s.bg != null ? 0 : (s.text.match(/^\s*/)?.[0].length ?? 0); first = pos + lead; } last = pos + s.text.length - (s.bg != null ? 0 : (s.text.match(/\s*$/)?.[0].length ?? 0)); }
      pos += s.text.length;
    }
    if (first < 0) range = null;
    else {
      const a = Math.max(range[0], first), b = Math.min(range[1], last);
      range = b > a ? [a, b] : null;
    }
  }
  let pos = 0;
  const lineLen = line.reduce((n, s) => n + displayWidth(s.text), 0);
  const trailing = Math.max(0, lineWidth - lineLen);
  // Extend a colored band (code/user/diff) to full width via the last span's bg;
  // a plain text line's last span has no bg, so the trailing stays transparent.
  const tailBg = line[line.length - 1]?.bg;
  return (
    <Text>
      {line.flatMap((s, j) => {
        const start = pos;
        const end = pos + s.text.length;
        pos = end;
        if (!range || end <= range[0] || start >= range[1]) {
          const span = (
            <Text key={j} color={s.color} bold={s.bold} italic={s.italic} dimColor={s.dim} backgroundColor={s.bg}>
              {s.text}
            </Text>
          );
          // NO OSC 8 hyperlinks here, even via Transform: Ink's clip/slice
          // layer is not OSC-aware, so a row clipped at the viewport edge
          // cuts the escape mid-sequence and prints the tail ("8;;") as
          // visible garbage. Paths/URLs render as plain styled text — every
          // modern terminal makes those clickable natively (cmd+click).
          return [span];
        }
        const a = Math.max(range[0] - start, 0);
        const b = Math.min(range[1] - start, s.text.length);
        // ONE selection treatment — the theme's dedicated selection band
        // (selBg/selInk), the single bg that must be UNMISSABLE. accentBg was
        // tried here and was near-invisible against the dark canvas. `inverse`
        // flipped every span's own color into a garish patchwork; one bright
        // band with uniform ink reads like selection should.
        return [
          s.text.slice(0, a) ? <Text key={`${j}-a`} color={s.color} bold={s.bold} italic={s.italic} dimColor={s.dim} backgroundColor={s.bg}>{s.text.slice(0, a)}</Text> : null,
          <Text key={`${j}-b`} color={color.selInk} bold={s.bold} backgroundColor={color.selBg}>{s.text.slice(a, b)}</Text>,
          s.text.slice(b) ? <Text key={`${j}-c`} color={s.color} bold={s.bold} italic={s.italic} dimColor={s.dim} backgroundColor={s.bg}>{s.text.slice(b)}</Text> : null,
        ].filter(Boolean);
      })}
      {trailing > 0 ? <Text backgroundColor={tailBg}>{" ".repeat(trailing)}</Text> : null}
    </Text>
  );
}, (a, b) =>
  a.line === b.line && a.lineWidth === b.lineWidth &&
  // Compare the selection RANGE by value: the parent derives a per-row range, so
  // during a drag only rows whose own band changed re-render — passing the whole
  // selection object re-rendered EVERY visible row per drag frame (it's a fresh
  // object each mouse event).
  (a.range === b.range || (a.range != null && b.range != null && a.range[0] === b.range[0] && a.range[1] === b.range[1])));

// One shared empty line for bottom padding — a fresh [] per render would break
// LineRow's reference-equality memo on every blank row.
const EMPTY_LINE: Line = [];

// The scroll region: shows exactly `height` rows from the line buffer starting at
// `scrollTop`, padded so the chrome below stays pinned, with a scrollbar on the
// right. Rendering a fixed line count is what keeps the frame from ever exceeding
// the screen (the cause of the earlier corruption).
export function Viewport({ lines, scrollTop, height, width, selection }: { lines: Line[]; scrollTop: number; height: number; width: number; selection?: ViewSelection | null }) {
  const visible = lines.slice(scrollTop, scrollTop + height);
  const padded: Line[] = visible.slice();
  while (padded.length < height) padded.push(EMPTY_LINE);
  const sel = normalized(selection);

  const total = lines.length;
  const hasBar = total > height;
  const thumb = hasBar ? Math.max(1, Math.round((height / total) * height)) : 0;
  const maxTop = Math.max(1, total - height);
  // Snap the thumb flush to the bottom when scrolled to the end, so rounding can't
  // leave it one row short of the floor at the true bottom (T-F).
  const thumbStart = !hasBar ? 0 : scrollTop >= maxTop ? height - thumb : Math.min(height - thumb, Math.round((scrollTop / maxTop) * (height - thumb)));

  return (
    <Box width={width}>
      <Box flexDirection="column" width={width - 1}>
        {/* Keyed by ABSOLUTE line, not screen row: a 3-line scroll then reuses
            every still-visible row's memoized element (same key, same line ref →
            LineRow's memo bails) instead of re-rendering the whole viewport.
            This is the difference between smooth and laggy wheel scrolling. */}
        {padded.map((l, i) => (
          <LineRow key={scrollTop + i} line={l} range={selectedRangeForLine(sel, scrollTop + i)} lineWidth={width - 1} />
        ))}
      </Box>
      <Box flexDirection="column" width={1}>
        {/* Thumb only — a full-height track (a column of `│` down the edge) read
            as visual noise. One multi-line Text instead of `height` Text nodes:
            the scrollbar moves every scroll frame, so its node count is pure
            per-frame reconciliation cost. */}
        <Text color={color.accentDim}>
          {Array.from({ length: height }, (_, i) => (hasBar && i >= thumbStart && i < thumbStart + thumb ? "┃" : " ")).join("\n")}
        </Text>
      </Box>
    </Box>
  );
}
