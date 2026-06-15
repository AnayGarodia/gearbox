import React from "react";
import { Box, Text } from "ink";
import { fmtElapsed } from "../lines.ts";
import { color } from "../theme.ts";
import { spinnerGlyph, spinnerFrame } from "../shimmer.ts";
import type { MascotState } from "./Mascot.tsx";

// The working beat (Broadsheet): a single now-row — a braille spinner + verb on
// the left, elapsed · esc on the right. The live tool steps stream in the
// transcript itself, so the strip stays a one-line "still alive" signal, not a
// duplicate activity log. No mascot here: while code runs the transcript is the
// show (Boo lives on the home screen).
//
// ROW-COUNT CONTRACT (keep in lockstep with App.tsx's footer estimate):
//   marginTop + the now-row = 2 rows, busy or linger.
export const workingRows = (_busy: boolean): number => 2;

const fmtTok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function Working({
  state,
  verb,
  elapsed,
  linger,
  width,
  waiting,
  tokens = 0,
}: {
  state: MascotState;
  verb: string;
  elapsed: number;
  linger?: boolean; // post-turn celebrate/error beat · show a label, not the timer
  width: number;
  waiting?: boolean; // a permission/question prompt is blocking the turn — it's on YOU, not the model
  tokens?: number; // live output-token burn this turn (Claude-Code style)
}) {
  // While a prompt blocks the turn, the model isn't working — say so in amber
  // and point down to the prompt, instead of a "Thinking · 30s" spinner that
  // reads as if it's still busy (the reported "the time and spinner keeps going").
  if (waiting) {
    return (
      <Box width={width} paddingX={1} marginTop={1}>
        <Text wrap="truncate-end" color={color.warn} bold>
          {"⚠ waiting for you"}
          <Text color={color.faint}>{"  · respond below ↓"}</Text>
        </Text>
      </Box>
    );
  }
  const label = linger ? (state === "error" ? "something broke" : "done") : verb;
  // A smooth braille spinner beside the verb (the ora/npm look) in a steady
  // accent color — the verb itself never changes color. No tok/s: a live
  // char-rate guess is dragged down by tool-call gaps, so the elapsed clock is
  // the only honest figure.
  const live = !linger;
  const dot = live ? spinnerGlyph(spinnerFrame()) : "●";
  const dotColor = live ? color.accent : state === "error" ? color.err : color.ok;
  return (
    <Box width={width} paddingX={1} marginTop={1} justifyContent="space-between">
      <Text>
        <Text color={dotColor}>{dot + " "}</Text>
        <Text color={live ? color.text : state === "error" ? color.err : color.ok}>{label}</Text>
      </Text>
      {live ? (
        <Text>
          {tokens > 0 ? <Text color={color.faint}>{`↑ ${fmtTok(tokens)} tok  ·  `}</Text> : null}
          <Text color={color.accentDim}>{fmtElapsed(elapsed)}</Text>
          <Text color={color.faint}> · esc interrupt</Text>
        </Text>
      ) : (
        <Text color={color.faint}> </Text>
      )}
    </Box>
  );
}
