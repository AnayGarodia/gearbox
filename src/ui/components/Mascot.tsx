import React from "react";
import { Box, Text } from "ink";
import { color } from "../theme.ts";

// Gearbox's mascot: a flexing gear-guy, built kaomoji-style (text faces are
// terminal-safe — they never reshape like emoji). Gear eyes ⚙ tie it to the
// brand; ᕙ ᕗ are the classic flexing arms; the grin ᗜ shows up while it works.
export const FACE = {
  idle: "(⚙‿⚙)",
  busy: "(⚙ᗜ⚙)",
  done: "(⚙ᴗ⚙)",
  oops: "(⚙_⚙;)",
} as const;

const HERO = "ᕙ(⚙‿⚙)ᕗ";

/** Big splash for the entry screen — centered hero pose + tagline. */
export function MascotSplash() {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box justifyContent="center">
        <Text color={color.accent}>{HERO}</Text>
      </Box>
      <Box justifyContent="center">
        <Text color={color.dim}>one gearbox · every model</Text>
      </Box>
    </Box>
  );
}

/** Tiny mascot perched on the input box; grins while working. */
export function MascotMini({ busy }: { busy: boolean }) {
  return (
    <Box paddingLeft={2}>
      <Text color={color.accent}>{busy ? FACE.busy : FACE.idle}</Text>
    </Box>
  );
}
