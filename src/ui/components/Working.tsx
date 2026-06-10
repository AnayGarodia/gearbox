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
//   full  (width ≥ WORKING_GHOST_MIN_W and rows ≥ WORKING_GHOST_MIN_H):
//         marginTop + STATE_GHOST_ROWS = 6 rows — Boo + verb + action + trail
//   compact: marginTop + 1 verb row = 2 rows (a 5-row ghost would eat a small
//         frame's transcript — the coding area outranks the mascot)
export const WORKING_GHOST_MIN_W = 60;
export const WORKING_GHOST_MIN_H = 32;
export const workingRows = (width: number, rows: number): number =>
  width >= WORKING_GHOST_MIN_W && rows >= WORKING_GHOST_MIN_H ? 1 + STATE_GHOST_ROWS : 2;

export function Working({
  state,
  verb,
  elapsed,
  linger,
  width,
  rows = 999,
  skin = "base",
  action,
  trail,
}: {
  state: MascotState;
  verb: string;
  elapsed: number;
  linger?: boolean; // post-turn celebrate/error beat · show a label, not the timer
  width: number;
  rows?: number; // terminal height — small frames drop the ghost (workingRows)
  skin?: GhostLook; // /ghost wardrobe — Boo works in the outfit you gave him
  action?: string | null; // current step (tool + target + ticking elapsed), beside Boo
  trail?: string | null; // recent steps/checks, beside Boo
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

  if (workingRows(width, rows) === 2) {
    // Compact frame: the one-line now-row (a 5-row ghost would crowd it).
    return (
      <Box width={width} paddingX={1} marginTop={1} justifyContent="space-between">
        {labelJsx}
        {figures}
      </Box>
    );
  }
  // Side column beside the head: verb + figures, then the live activity (the
  // current step and a short trail) — the "what is it doing NOW" rail folded
  // into rows Boo already occupies, so it costs no extra height.
  const room = Math.max(12, width - 2 - 20 - 2); // padding + ghost cols + gap
  return (
    <Box width={width} paddingX={1} marginTop={1}>
      <StateGhost state={state} skin={skin} />
      <Box flexDirection="column" flexGrow={1} height={STATE_GHOST_ROWS} justifyContent="center" marginLeft={2}>
        <Box justifyContent="space-between">
          {labelJsx}
          {figures}
        </Box>
        {!linger && action ? (
          <Text wrap="truncate-end">
            <Text color={color.accentDim}>{"▸ "}</Text>
            <Text color={color.dim}>{action.slice(0, room)}</Text>
          </Text>
        ) : null}
        {!linger && trail ? <Text color={color.faint} wrap="truncate-end">{"  " + trail.slice(0, room)}</Text> : null}
      </Box>
    </Box>
  );
}
