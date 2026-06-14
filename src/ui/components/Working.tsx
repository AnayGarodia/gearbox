import React from "react";
import { Box, Text } from "ink";
import { fmtElapsed } from "../lines.ts";
import { color } from "../theme.ts";
import { pulseColor, shimmerFrame } from "../shimmer.ts";
import type { MascotState } from "./Mascot.tsx";

// The working beat (Broadsheet): a compact two-line now block. Line 1 is the
// shimmering verb with the figures (elapsed · esc) at the page's right edge;
// line 2 is the live activity — the current step with its ticking elapsed and
// a short trail of recent steps/checks. No mascot here: while code runs the
// transcript is the show, and rows belong to it (Boo lives on the home screen).
//
// ROW-COUNT CONTRACT (keep in lockstep with App.tsx's footer estimate):
//   busy: marginTop + verb row + activity row = 3 rows (activity may be empty
//         early in a turn — the frame under-fills by one row, which is safe)
//   linger (the post-turn done/error beat): marginTop + verdict row = 2 rows
export const workingRows = (busy: boolean): number => (busy ? 3 : 2);

export function Working({
  state,
  verb,
  elapsed,
  linger,
  width,
  action,
  trail,
}: {
  state: MascotState;
  verb: string;
  elapsed: number;
  linger?: boolean; // post-turn celebrate/error beat · show a label, not the timer
  width: number;
  action?: string | null; // current step (tool + target + ticking elapsed)
  trail?: string | null; // recent steps/checks
}) {
  const label = linger ? (state === "error" ? "something broke" : "done") : verb;
  // The verb sits in ONE steady color; a single dot beside it breathes dim →
  // bright → dim (pulseColor) as the quiet sign of life. The word never changes
  // color (a per-character gradient read as garbled multicolor text). No tok/s:
  // a live char-rate guess is dragged down by tool-call gaps, so the elapsed
  // clock is the only honest "still alive" figure.
  const live = !linger;
  const dotColor = live ? pulseColor(shimmerFrame()) : state === "error" ? color.err : color.ok;
  const labelJsx = (
    <Text>
      <Text color={dotColor}>{"● "}</Text>
      <Text color={live ? color.text : state === "error" ? color.err : color.ok}>{label}</Text>
    </Text>
  );
  const activity = [action, trail].filter(Boolean).join("   ");
  // ROW-COUNT CONTRACT: the activity row is ALWAYS rendered while live (a blank
  // space when there's no step yet) so the block is a fixed 3 rows from the
  // first frame — the transcript above never shifts up when the first step
  // appears mid-turn.
  return (
    <Box width={width} paddingX={1} marginTop={1} flexDirection="column">
      <Box justifyContent="space-between">
        {labelJsx}
        {live ? (
          <Text>
            <Text color={color.accentDim}>{fmtElapsed(elapsed)}</Text>
            <Text color={color.faint}> · esc interrupt</Text>
          </Text>
        ) : (
          <Text color={color.faint}> </Text>
        )}
      </Box>
      {live ? (
        <Text wrap="truncate-end">
          {activity ? (
            <>
              <Text color={color.accentDim}>{"▸ "}</Text>
              <Text color={color.dim}>{activity.slice(0, Math.max(12, width - 4))}</Text>
            </>
          ) : (
            <Text> </Text>
          )}
        </Text>
      ) : null}
    </Box>
  );
}
