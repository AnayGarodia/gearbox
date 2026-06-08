import React from "react";
import { Box, Text } from "ink";
import { color } from "../theme.ts";
import { lowContextNotice } from "../character.ts";
import { shimmer, shimmerFrame } from "../shimmer.ts";
import type { MascotState } from "./Mascot.tsx";

// One-line working strip. The larger ghost stays out of the transcript and
// selection zones; state is carried by color + concise text.

export function Working({
  state,
  verb,
  elapsed,
  tps = 0,
  linger,
  width,
  ctxPct = null,
}: {
  state: MascotState;
  verb: string;
  elapsed: number;
  tps?: number; // live output tokens/sec estimate
  linger?: boolean; // post-turn celebrate/error beat · show a label, not the timer
  width: number;
  ctxPct?: number | null; // context % used; an amber notice shows only when low
}) {
  // Low-context notice: shown only when the window is genuinely low (≥85% used),
  // never during the post-turn linger beat. Real figure or nothing.
  const ctxNotice = linger ? null : lowContextNotice(ctxPct);
  const label = linger ? (state === "error" ? "something broke" : "done") : verb;
  const labelColor = linger && state === "error" ? color.err : linger && state === "celebrate" ? color.ok : color.text;
  // The ONE working animation: a bright "current" sweeps through the verb (shimmer.ts).
  // No spinner glyph, no pulsing dots — calm, and shown exactly once.
  const sweep = shimmer(label, shimmerFrame());
  return (
    <Box flexDirection="column" width={width}>
      <Box width={width} paddingX={1} marginTop={1} justifyContent="space-between">
        {linger ? (
          <Text color={labelColor}>
            <Text color={state === "error" ? color.err : color.ok}>● </Text>
            {label}
          </Text>
        ) : (
          <Text>{sweep.map((s, i) => <Text key={i} color={s.color}>{s.ch}</Text>)}</Text>
        )}
        {/* tok/s only shows once it's a real streaming rate (App measures from the
            first output token, not total elapsed · otherwise it reads as ~1/s). */}
        {!linger ? <Text><Text color={color.accentDim}>{elapsed}s</Text><Text color={color.faint}>{tps >= 5 ? ` · ~${tps} tok/s` : ""} · esc to interrupt</Text></Text> : <Text color={color.faint}> </Text>}
      </Box>
      {ctxNotice ? <Box paddingX={1}><Text color={color.warn}>{ctxNotice}</Text></Box> : null}
    </Box>
  );
}
