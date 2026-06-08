import React from "react";
import { Box, Text } from "ink";
import { color } from "../theme.ts";
import { lowContextNotice } from "../character.ts";
import { shimmer, shimmerFrame, bloom } from "../shimmer.ts";
import type { MascotState } from "./Mascot.tsx";

// One-line working strip. The larger ghost stays out of the transcript and
// selection zones; state is carried by color + concise text.

export function Working({
  state,
  verb,
  elapsed,
  linger,
  width,
  ctxPct = null,
}: {
  state: MascotState;
  verb: string;
  elapsed: number;
  linger?: boolean; // post-turn celebrate/error beat · show a label, not the timer
  width: number;
  ctxPct?: number | null; // context % used; an amber notice shows only when low
}) {
  // Low-context notice: shown only when the window is genuinely low (≥85% used),
  // never during the post-turn linger beat. Real figure or nothing.
  const ctxNotice = linger ? null : lowContextNotice(ctxPct);
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
    <Box flexDirection="column" width={width}>
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
        {!linger ? <Text><Text color={color.accentDim}>{elapsed}s</Text><Text color={color.faint}> · esc to interrupt</Text></Text> : <Text color={color.faint}> </Text>}
      </Box>
      {ctxNotice ? <Box paddingX={1}><Text color={color.warn}>{ctxNotice}</Text></Box> : null}
    </Box>
  );
}
