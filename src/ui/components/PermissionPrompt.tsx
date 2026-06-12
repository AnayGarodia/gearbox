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
// ROW CONTRACT: marginTop(1) + title(1) + command(1) + options(4) + marginBottom(1)
// = 8 rows. App.tsx's footer estimate (`if (perm) footer += 8`) MUST match —
// update both in lockstep.
export function PermissionPrompt({ req, width }: { req: PermRequest; width: number }) {
  const shell = req.kind === "shell";
  // One option per row (user feedback): the dot-joined single line truncated
  // mid-option at narrow widths; a column scans instantly and lets each choice
  // say what it actually does.
  const options: { k: string; label: string; note: string }[] = [
    { k: "1", label: "allow once", note: "ask again next time" },
    { k: "2", label: `always allow ${shell ? "shell commands" : req.kind === "edit" ? "edits" : "writes"}`, note: "this session" },
    { k: "a", label: "allow everything", note: "yolo · no more prompts" },
    { k: "3", label: "deny", note: "esc also denies" },
  ];
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
      {options.map((o) => (
        <Text key={o.k} wrap="truncate-end">
          <Text color={color.accent} bold>{"  " + o.k}</Text>
          <Text color={color.text}>{" " + o.label}</Text>
          <Text color={color.faint}>{"  · " + o.note}</Text>
        </Text>
      ))}
    </Box>
  );
}
