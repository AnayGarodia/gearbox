import React from "react";
import { Box, Text } from "ink";
import { color } from "../theme.ts";
import { shimmer, shimmerFrame, bloom } from "../shimmer.ts";
import type { MascotState } from "./Mascot.tsx";

// The "now" row (Broadsheet): one line in the page column. Boo's bloom + the
// shimmering verb left; the figures (elapsed · esc interrupt) right-aligned at
// the page's right edge, like every other margin figure. The low-context notice
// that used to render under this line is gone — the meter's context gauge
// (StatusBar) carries that signal now, in one place.

export function Working({
  state,
  verb,
  elapsed,
  linger,
  width,
}: {
  state: MascotState;
  verb: string;
  elapsed: number;
  linger?: boolean; // post-turn celebrate/error beat · show a label, not the timer
  width: number;
}) {
  const label = linger ? (state === "error" ? "something broke" : "done") : verb;
  const labelColor = linger && state === "error" ? color.err : linger && state === "celebrate" ? color.ok : color.text;
  // The working animation: a blooming flower + a soft glow gliding through the verb
  // (shimmer.ts). Calm, continuous, on-brand — not a spinner. No tok/s: a live
  // char-rate guess is dragged down by tool-call gaps, so the elapsed clock is the
  // only honest "still alive" figure we show.
  const frame = shimmerFrame();
  const glow = shimmer(label, frame);
  const flower = bloom(frame);
  return (
    <Box width={width} paddingX={1} marginTop={1} justifyContent="space-between">
      {linger ? (
        <Text color={labelColor}>
          <Text color={state === "error" ? color.err : color.ok}>● </Text>
          {label}
        </Text>
      ) : (
        <Text>
          <Text color={flower.color}>{flower.glyph} </Text>
          {glow.map((s, i) => <Text key={i} color={s.color}>{s.ch}</Text>)}
        </Text>
      )}
      {!linger ? <Text><Text color={color.accentDim}>{elapsed}s</Text><Text color={color.faint}> · esc interrupt</Text></Text> : <Text color={color.faint}> </Text>}
    </Box>
  );
}
