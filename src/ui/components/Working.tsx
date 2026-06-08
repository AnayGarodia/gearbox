import React from "react";
import { Box, Text } from "ink";
import { color, spinnerPalette } from "../theme.ts";
import { lowContextNotice } from "../character.ts";
import type { MascotState, GhostSkin } from "./Mascot.tsx";

const THINK_FRAMES = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
const STREAM_FRAMES = ["▁","▂","▃","▄","▅","▆","▇","█","▇","▆","▅","▄","▃","▂"];
const TOOL_FRAMES = ["◐","◓","◑","◒"];

function spinFrame(state: MascotState): string {
  const f = Math.floor(Date.now() / 80);
  if (state === "streaming") return STREAM_FRAMES[f % STREAM_FRAMES.length]!;
  if (state === "tool") return TOOL_FRAMES[f % TOOL_FRAMES.length]!;
  return THINK_FRAMES[f % THINK_FRAMES.length]!;
}

function spinColor(state: MascotState): string {
  if (state === "streaming") return color.ok;
  const f = Math.floor(Date.now() / 180);
  return spinnerPalette[f % spinnerPalette.length]!;
}

// One-line working strip. The larger ghost stays out of the transcript and
// selection zones; state is carried by color + concise text.

export function Working({
  state,
  skin,
  verb,
  elapsed,
  tps = 0,
  linger,
  width,
  ctxPct = null,
}: {
  state: MascotState;
  skin: GhostSkin;
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
  const dotColor = linger ? (state === "error" ? color.err : color.ok) : spinColor(state);
  const spinner = linger ? "●" : spinFrame(state);
  const f = Math.floor(Date.now() / 360);
  const dots = ["", ".", "..", "..."][f % 4]!;
  // One verb only · the gear-themed flavour word IS the activity; don't also stack
  // the literal "thinking". Boo's face already carries the state.
  return (
    <Box flexDirection="column" width={width}>
      <Box width={width} paddingX={1} marginTop={1} justifyContent="space-between">
        <Text color={labelColor}>
          <Text color={dotColor}>{spinner} </Text>
          {label}
          {!linger ? <Text color={color.accentDim}>{dots}</Text> : null}
        </Text>
        {/* tok/s only shows once it's a real streaming rate (App measures from the
            first output token, not total elapsed · otherwise it reads as ~1/s). */}
        {!linger ? <Text><Text color={color.accentDim}>{elapsed}s</Text><Text color={color.faint}>{tps >= 5 ? ` · ~${tps} tok/s` : ""} · esc to interrupt</Text></Text> : <Text color={color.faint}> </Text>}
      </Box>
      {ctxNotice ? <Box paddingX={1}><Text color={color.warn}>{ctxNotice}</Text></Box> : null}
    </Box>
  );
}
