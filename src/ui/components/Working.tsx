import React from "react";
import { Box, Text } from "ink";
import { fmtElapsed } from "../lines.ts";
import { color } from "../theme.ts";
import { breathGlyph, shimmerFrame } from "../shimmer.ts";
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
  waiting,
}: {
  state: MascotState;
  verb: string;
  elapsed: number;
  linger?: boolean; // post-turn celebrate/error beat · show a label, not the timer
  width: number;
  action?: string | null; // current step (tool + target + ticking elapsed)
  trail?: string | null; // recent steps/checks
  waiting?: boolean; // a permission/question prompt is blocking the turn — it's on YOU, not the model
}) {
  // While a prompt blocks the turn, the model isn't working — say so in amber
  // and point down to the prompt, instead of a "Thinking · 30s" spinner that
  // reads as if it's still busy (the reported "the time and spinner keeps going").
  if (waiting) {
    return (
      <Box width={width} paddingX={1} marginTop={1} flexDirection="column">
        <Text wrap="truncate-end" color={color.warn} bold>
          {"⚠ waiting for you"}
          <Text color={color.faint}>{"  · respond below ↓"}</Text>
        </Text>
        <Text> </Text>
      </Box>
    );
  }
  const label = linger ? (state === "error" ? "something broke" : "done") : verb;
  // A single dot BREATHES in size (· • ● •) beside the verb as the quiet sign
  // of life, in a steady color (a color-flickering glyph read as a glitch). The
  // verb itself never changes color. No tok/s: a live char-rate guess is dragged
  // down by tool-call gaps, so the elapsed clock is the only honest figure.
  const live = !linger;
  const dot = live ? breathGlyph(shimmerFrame()) : "●";
  const dotColor = live ? color.accent : state === "error" ? color.err : color.ok;
  const labelJsx = (
    <Text>
      <Text color={dotColor}>{dot + " "}</Text>
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
