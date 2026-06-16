import React from "react";
import { Box, Text } from "ink";
import { color } from "../theme.ts";
import { Button } from "./kit.tsx";
import { displayWidth } from "../width.ts";
import type { PermRequest } from "../../permission.ts";

// The consent card (Quiet Workshop): a decision is the one loud moment in the
// quiet flow, so it gets a contained ROUNDED card with hotkey BUTTONS. A
// warn-amber border marks a shell command (the riskiest kind); writes/edits get
// the accent border. While it's pending, history recedes — this card is the only
// bright thing on screen. The button keys are unchanged (⏎ / 2 / a / esc), so
// App.tsx's key handler is untouched.

// The buttons, in render order. Shared by the component AND permPromptRows so the
// width prediction can never drift from what's actually drawn. Labels are kept
// SHORT ("Always", not "Always allow shell/writes/edits") so the row fits one
// line on an ordinary terminal — the kind is already named in the card title.
function buttons(req: PermRequest): { hotkey: string; label: string }[] {
  return [
    { hotkey: "⏎", label: "Allow" },
    { hotkey: "2", label: "Always" },
    { hotkey: "a", label: "Yolo" },
    { hotkey: "esc", label: "Deny" },
  ];
}

const BTN_SEP = "  ";
// A Button renders ` ${hotkey} ` + ` ${label}` → hotkey+2 + label+1 columns.
function buttonsWidth(req: PermRequest): number {
  const btns = buttons(req);
  const w = btns.reduce((s, b) => s + displayWidth(` ${b.hotkey} `) + displayWidth(` ${b.label}`), 0);
  return w + displayWidth(BTN_SEP) * (btns.length - 1);
}

// ROW CONTRACT (width-aware): marginTop(1) + borderTop(1) + title(1) + command(1)
// + buttons(L) + borderBottom(1) + marginBottom(1) = 6 + L, where L is the number
// of lines the button row wraps to inside the card's content area. App.tsx's
// footer budget MUST call this with the SAME width the card is rendered at
// (pageW in fullscreen) — over-counting under-fills the frame (safe); under-
// counting over-fills it and clips (the bug this replaced).
export function permPromptRows(req: PermRequest, width: number): number {
  const inner = Math.max(1, width - 4); // border(2) + paddingLeft/Right(2)
  const lines = Math.max(1, Math.ceil(buttonsWidth(req) / inner));
  return 6 + lines;
}

export function PermissionPrompt({ req, width }: { req: PermRequest; width: number }) {
  const shell = req.kind === "shell";
  const edge = shell ? color.warn : color.accent;
  const btns = buttons(req);
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
          {btns.map((b, i) => (
            <React.Fragment key={b.hotkey}>
              {i > 0 ? <Text>{BTN_SEP}</Text> : null}
              <Button hotkey={b.hotkey} label={b.label} tone={b.hotkey === "esc" ? color.dim : edge} />
            </React.Fragment>
          ))}
        </Box>
      </Box>
    </Box>
  );
}
