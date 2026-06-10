import React from "react";
import { Box, Text } from "ink";
import { color } from "../theme.ts";
import type { PermRequest } from "../../permission.ts";

// The consent line (Broadsheet): a flat element-layer block, not a floating
// card. Title row, the verbatim command/path on the element layer, single-key
// options. A warn-colored left edge marks a shell command (the riskiest kind);
// writes/edits get the accent edge. While it's pending, history recedes — this
// block is the only bright thing on screen.
//
// ROW CONTRACT: marginTop(1) + title(1) + command(1) + options(1) + marginBottom(1)
// = 5 rows. App.tsx's footer estimate (`if (perm) footer += 5`) MUST match —
// update both in lockstep.
export function PermissionPrompt({ req, width }: { req: PermRequest; width: number }) {
  const shell = req.kind === "shell";
  return (
    <Box
      flexDirection="column"
      width={width}
      marginTop={1}
      marginBottom={1}
      borderStyle="single"
      borderColor={shell ? color.warn : color.accent}
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      paddingLeft={1}
    >
      <Text wrap="truncate-end">
        <Text color={color.accent} bold>{"▸ "}</Text>
        <Text color={color.text} bold>permission</Text>
        <Text color={color.dim}>{" · " + req.title}</Text>
      </Text>
      <Text wrap="truncate-end">
        <Text color={color.path} backgroundColor={color.elementBg}>{" " + req.detail.replace(/\n/g, " ⏎ ") + " "}</Text>
      </Text>
      <Text wrap="truncate-end">
        <Text color={color.accent} bold>1</Text>
        <Text color={color.dim}> once</Text>
        <Text color={color.faint}>{" · "}</Text>
        <Text color={color.accent} bold>2</Text>
        <Text color={color.dim}> always ({req.kind})</Text>
        <Text color={color.faint}>{" · "}</Text>
        <Text color={color.accent} bold>a</Text>
        <Text color={color.dim}> all</Text>
        <Text color={color.faint}>{" · "}</Text>
        <Text color={color.accent} bold>3</Text>
        <Text color={color.dim}> deny</Text>
        <Text color={color.faint}> · esc</Text>
      </Text>
    </Box>
  );
}
