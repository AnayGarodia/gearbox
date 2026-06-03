import React from "react";
import { Box, Text } from "ink";
import { color } from "../theme.ts";
import { StateGhost, type MascotState, type GhostSkin } from "./Mascot.tsx";

// The working line, pinned to the RIGHT end. Boo IS the indicator now: a compact,
// native-resolution head-crop ghost (src/ui/ghost/engine.ts) whose face changes
// with the agent's state — thinking → reasoning, streaming → talking mouth, tool
// → running, a clean finish → confetti, an error → crying with falling tears. The
// verb + elapsed + interrupt hint sit to Boo's LEFT, vertically centered; Boo
// hugs the right edge. The ghost carries its own (deliberately calm) motion, so
// there is no separate spinner glyph.

export function Working({
  state,
  skin,
  verb,
  elapsed,
  linger,
  width,
}: {
  state: MascotState;
  skin: GhostSkin;
  verb: string;
  elapsed: number;
  linger?: boolean; // post-turn celebrate/error beat — show a label, not the timer
  width: number;
}) {
  const label = linger ? (state === "error" ? "something broke" : "done") : verb;
  const labelColor = linger && state === "error" ? color.err : linger && state === "celebrate" ? color.ok : color.text;
  return (
    <Box width={width} paddingX={1} marginTop={1} alignItems="center" justifyContent="flex-end">
      <Box marginRight={1} flexDirection="column" alignItems="flex-end">
        <Text color={labelColor}>{label}</Text>
        {!linger ? (
          <Text color={color.faint}>{elapsed}s · esc to interrupt</Text>
        ) : null}
      </Box>
      <StateGhost state={state} skin={skin} />
    </Box>
  );
}
