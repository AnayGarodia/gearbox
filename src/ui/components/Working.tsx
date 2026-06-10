import React from "react";
import { Box, Text } from "ink";
import { color } from "../theme.ts";
import { shimmer, shimmerFrame } from "../shimmer.ts";
import { StateGhost, STATE_GHOST_ROWS, type MascotState, type GhostLook } from "./Mascot.tsx";

// The working beat (Broadsheet): Boo IS the indicator. A compact head-crop
// ghost whose face carries the agent's state — thinking (pulsing dots) →
// streaming (talking mouth) → tool (loading fill) → celebrate (confetti) /
// error (tears) — with the shimmering verb beside him and the figures
// (elapsed · esc) at the page's right edge. Boo is deliberately CALM through
// the long phases: thinking/tool barely move; only the brief, meaningful
// beats animate. The block is STATE_GHOST_ROWS tall (one fixed crop for every
// state, so the composer below never shifts).
//
// ROW-COUNT CONTRACT (keep in lockstep with App.tsx's footer estimate):
//   wide  (width ≥ WORKING_GHOST_MIN_W): marginTop + STATE_GHOST_ROWS = 6 rows
//   narrow: marginTop + 1 verb row = 2 rows (the ghost would crowd a tiny frame)
export const WORKING_GHOST_MIN_W = 60;
export const workingRows = (width: number): number => (width >= WORKING_GHOST_MIN_W ? 1 + STATE_GHOST_ROWS : 2);

export function Working({
  state,
  verb,
  elapsed,
  linger,
  width,
  skin = "base",
}: {
  state: MascotState;
  verb: string;
  elapsed: number;
  linger?: boolean; // post-turn celebrate/error beat · show a label, not the timer
  width: number;
  skin?: GhostLook; // /ghost wardrobe — Boo works in the outfit you gave him
}) {
  const label = linger ? (state === "error" ? "something broke" : "done") : verb;
  // The verb glows (shimmer.ts) while live; the linger label sits still in its
  // verdict color. No tok/s: a live char-rate guess is dragged down by
  // tool-call gaps, so the elapsed clock is the only honest "still alive" figure.
  const live = !linger;
  const glow = live ? shimmer(label, shimmerFrame()) : null;
  const labelJsx = glow ? (
    <Text>{glow.map((s, i) => <Text key={i} color={s.color}>{s.ch}</Text>)}</Text>
  ) : (
    <Text color={state === "error" ? color.err : color.ok}>{label}</Text>
  );
  const figures = live ? (
    <Text>
      <Text color={color.accentDim}>{elapsed}s</Text>
      <Text color={color.faint}> · esc interrupt</Text>
    </Text>
  ) : (
    <Text color={color.faint}> </Text>
  );

  if (width < WORKING_GHOST_MIN_W) {
    // Narrow frame: the one-line now-row (a 5-row ghost would crowd it).
    return (
      <Box width={width} paddingX={1} marginTop={1} justifyContent="space-between">
        {labelJsx}
        {figures}
      </Box>
    );
  }
  return (
    <Box width={width} paddingX={1} marginTop={1}>
      <StateGhost state={state} skin={skin} />
      {/* The text column rides beside the head, centered on its height; the
          figures right-align inside it so they land at the page's right edge. */}
      <Box flexDirection="column" flexGrow={1} height={STATE_GHOST_ROWS} justifyContent="center" marginLeft={2}>
        <Box justifyContent="space-between">
          {labelJsx}
          {figures}
        </Box>
      </Box>
    </Box>
  );
}
