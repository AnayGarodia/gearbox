import React from "react";
import { Box, Text } from "ink";
import { color } from "../theme.ts";
import { Button } from "./kit.tsx";
import type { PermRequest } from "../../permission.ts";

// The consent card (Quiet Workshop): a decision is the one loud moment in the
// quiet flow, so it gets a contained ROUNDED card with hotkey BUTTONS. A
// warn-amber border marks a shell command (the riskiest kind); writes/edits get
// the accent border. While it's pending, history recedes — this card is the only
// bright thing on screen. The button keys are unchanged (1 / 2 / a / esc), so
// App.tsx's key handler is untouched.
//
// ROW CONTRACT: marginTop(1) + borderTop(1) + title(1) + command(1) + buttons(1)
// + borderBottom(1) + marginBottom(1) = 7 rows. App.tsx's footer estimate
// (`if (perm) footer += 7`) MUST match — update both in lockstep.
export function PermissionPrompt({ req, width }: { req: PermRequest; width: number }) {
  const shell = req.kind === "shell";
  const edge = shell ? color.warn : color.accent;
  const alwaysLabel = `Always allow ${shell ? "shell" : req.kind === "edit" ? "edits" : "writes"}`;
  return (
    <Box flexDirection="column" width={width} marginTop={1} marginBottom={1}>
      <Box flexDirection="column" borderStyle="round" borderColor={edge} paddingLeft={1} paddingRight={1}>
        <Text wrap="truncate-end">
          <Text color={edge} bold>{(shell ? "Permission · shell" : "Permission") + " "}</Text>
          <Text color={color.dim}>{req.title}</Text>
        </Text>
        <Text wrap="truncate-end">
          <Text color={color.path} backgroundColor={color.elementBg}>{" " + req.detail.replace(/\n/g, " ⏎ ") + " "}</Text>
        </Text>
        <Box>
          <Button hotkey="⏎" label="Allow" tone={edge} />
          <Text>{"  "}</Text>
          <Button hotkey="2" label={alwaysLabel} tone={edge} />
          <Text>{"  "}</Text>
          <Button hotkey="a" label="Yolo" tone={edge} />
          <Text>{"  "}</Text>
          <Button hotkey="esc" label="Deny" tone={color.dim} />
        </Box>
      </Box>
    </Box>
  );
}
