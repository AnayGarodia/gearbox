import React from "react";
import { Box, Text } from "ink";
import { color, glyph } from "../theme.ts";
import type { PermRequest } from "../../permission.ts";

// A blocking confirm before Boo writes, edits, or runs a shell command. A bordered
// card is right here · it's a modal decision (Gemini/Copilot frame these the same).
export function PermissionPrompt({ req, width }: { req: PermRequest; width: number }) {
  return (
    <Box flexDirection="column" width={width} marginTop={1} paddingX={1} borderStyle="round" borderColor={color.accent}>
      <Box>
        <Text color={color.accent} bold>{glyph.notice} permission</Text>
        <Text color={color.faint}>{"  "}{req.title}</Text>
      </Box>
      <Box marginTop={1}>
        <Box flexGrow={1}>
          <Text color={color.text} wrap="truncate-end">{req.detail}</Text>
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text color={color.accent} bold>1</Text>
        <Text color={color.dim}> once</Text>
        <Text color={color.faint}>{"   "}</Text>
        <Text color={color.accent} bold>2</Text>
        <Text color={color.dim}> always ({req.kind})</Text>
        <Text color={color.faint}>{"   "}</Text>
        <Text color={color.accent} bold>a</Text>
        <Text color={color.dim}> all · yolo</Text>
        <Text color={color.faint}>{"   "}</Text>
        <Text color={color.err} bold>3</Text>
        <Text color={color.dim}> deny</Text>
        <Text color={color.faint}> · esc</Text>
      </Box>
    </Box>
  );
}
