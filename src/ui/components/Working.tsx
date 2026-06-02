import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { color } from "../theme.ts";
import { SPINNER_FRAMES } from "../character.ts";

// The "working" line: a smooth spinner + a workshop verb + elapsed + interrupt hint.
export function Working({ elapsed, verb }: { elapsed: number; verb: string }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 90);
    return () => clearInterval(t);
  }, []);
  return (
    <Box paddingX={1} marginTop={1}>
      <Text color={color.accent}>{SPINNER_FRAMES[frame]} </Text>
      <Text color={color.text}>{verb}</Text>
      <Text color={color.faint}>
        {"  "}
        {elapsed}s · esc to interrupt
      </Text>
    </Box>
  );
}
