import React from "react";
import { Box, Text } from "ink";
import { color } from "../theme.ts";

// Gearbox's mascot: a little gear-bot. Two gears sit right over its eyes (the
// "gear box"), with a friendly face. Box-drawing keeps it monospace-aligned.

const ART = [
  "   ⚙   ⚙", // gear "ears" — aligned over the eyes below (cols 3 and 7)
  "╭─────────╮",
  "│  ●   ●  │",
  "│    ‿    │",
  "╰─────────╯",
];

/** Big splash for the entry screen. */
export function MascotSplash() {
  return (
    <Box flexDirection="column" paddingX={1}>
      {ART.map((line, i) => (
        <Text key={i} color={i === 0 ? color.accentDim : color.accent}>
          {line}
        </Text>
      ))}
    </Box>
  );
}

/** Tiny mascot that perches just above the input box; eyes change when working. */
export function MascotMini({ busy }: { busy: boolean }) {
  return (
    <Box paddingLeft={2}>
      <Text color={color.accent}>{busy ? "●▾●" : "●‿●"}</Text>
    </Box>
  );
}
