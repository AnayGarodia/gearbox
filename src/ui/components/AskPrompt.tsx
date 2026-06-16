import React from "react";
import { Box, Text } from "ink";
import { color } from "../theme.ts";
import type { AskRequest } from "../../ask.ts";
import type { AskPickerState } from "../ask-picker.ts";

// The clarifying-question card (Quiet Workshop): the agent paused on an ask_user
// tool call, so it gets the same contained ROUNDED decision card as a permission
// prompt — the current question, its options as a radio (single) or checkbox
// (multi) list, and a key hint. App.tsx owns the keys.
//
// ROW CONTRACT: marginTop(1) + borderTop(1) + question(1) + options(N) + hint(1)
// + borderBottom(1) + marginBottom(1) = N + 6. App's footer estimate must match
// askPromptRows() below.
export function askPromptRows(req: AskRequest, picker: AskPickerState): number {
  const q = req.questions[picker.qIndex];
  const opts = q?.options?.length ?? 0;
  return opts + 6; // marginTop + borderTop + question + opts + hint + borderBottom + marginBottom
}

export function AskPrompt({ req, picker, width }: { req: AskRequest; picker: AskPickerState; width: number }) {
  const q = req.questions[picker.qIndex];
  if (!q) return null;
  const counter = req.questions.length > 1 ? `(${picker.qIndex + 1}/${req.questions.length}) ` : "";
  const hint = q.multiSelect ? "↑↓ move · space toggle · ⏎ next · esc skip" : "↑↓ move · ⏎ select · esc skip";
  return (
    <Box flexDirection="column" width={width} marginTop={1} marginBottom={1}>
      <Box flexDirection="column" borderStyle="round" borderColor={color.accent} paddingLeft={1} paddingRight={1}>
        <Text wrap="truncate-end">
          <Text color={color.accent} bold>{"Gearbox asks  "}</Text>
          <Text color={color.dim}>{counter}</Text>
          <Text color={color.text} bold>{q.question}</Text>
        </Text>
        {(q.options ?? []).map((opt, i) => {
          const here = i === picker.cursor;
          const checked = q.multiSelect ? picker.selected.has(i) : here;
          const mark = q.multiSelect ? (checked ? "[x]" : "[ ]") : here ? "◉" : "○";
          return (
            <Text key={i} wrap="truncate-end">
              <Text color={color.accent} bold>{here ? "❯ " : "  "}</Text>
              <Text color={checked ? color.ok : color.faint}>{mark + " "}</Text>
              <Text color={here ? color.text : color.dim} bold={here}>{opt.label}</Text>
              {opt.description ? <Text color={color.faint}>{"  " + opt.description}</Text> : null}
            </Text>
          );
        })}
        <Text color={color.faint} wrap="truncate-end">{hint}</Text>
      </Box>
    </Box>
  );
}
