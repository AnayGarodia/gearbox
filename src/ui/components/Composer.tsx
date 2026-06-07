import React from "react";
import { Box, Text } from "ink";
import { color, glyph } from "../theme.ts";
import { caretPos, selectionRange, type Edit } from "../input.ts";

// Borderless composer: a hairline rule, then a `❯` prompt with the input and a
// terminal-native block cursor (`inverse`). Multi-line aware · continuation lines
// align under the prompt and the cursor lands on the right row/column. No box.
export function Composer({
  value,
  cursor,
  selectionAnchor,
  placeholder,
  suggestion,
  busy,
  width,
  vim = "off",
  onEdit,
}: {
  value: string;
  cursor: number;
  selectionAnchor?: number;
  placeholder: string;
  suggestion?: string | null;
  busy: boolean;
  width: number;
  vim?: "off" | "insert" | "normal";
  onEdit?: (edit: Edit) => void;
}) {
  const lines = value.split("\n");
  const { lineIdx: curLine, col: curCol } = caretPos(value, cursor);
  const selected = selectionRange({ value, cursor, selectionAnchor });
  // Shell mode: a leading `!` runs the line as a shell command. Give it a distinct
  // pink accent + badge so it never reads like a chat message or a /command.
  const shellMode = value.startsWith("!");
  const accent = shellMode ? color.shell : color.accent;
  const prefix = (i: number) => (i === 0 ? glyph.prompt + " " : "  ");
  const offsetOfLine = (line: number) => {
    let off = 0;
    for (let i = 0; i < line; i++) off += lines[i]!.length + 1;
    return off;
  };
  const renderLine = (ln: string, line: number) => {
    const lineStart = offsetOfLine(line);
    const lineEnd = lineStart + ln.length;
    const selStart = selected ? Math.max(selected[0], lineStart) - lineStart : -1;
    const selEnd = selected ? Math.min(selected[1], lineEnd) - lineStart : -1;
    const hasSel = selected && selStart < selEnd;
    const cursorHere = line === curLine;
    if (!hasSel) {
      if (!cursorHere) return <Text backgroundColor={color.panelBg}>{ln}</Text>;
      return (
        <Text backgroundColor={color.panelBg}>
          {ln.slice(0, curCol)}
          <Text inverse backgroundColor={color.panelBg}>{ln[curCol] ?? " "}</Text>
          {ln.slice(curCol + 1)}
        </Text>
      );
    }
    return (
      <Text backgroundColor={color.panelBg}>
        {ln.slice(0, selStart)}
        <Text inverse>{ln.slice(selStart, selEnd)}</Text>
        {ln.slice(selEnd)}
      </Text>
    );
  };

  // Badge shown at the left of the hairline rule: shell mode wins, then vim.
  const badge = shellMode
    ? { text: " ! bash ", c: color.shell }
    : vim === "normal"
    ? { text: " NORMAL ", c: color.accent }
    : vim === "insert"
    ? { text: " INSERT ", c: color.dim }
    : null;

  return (
    <Box flexDirection="column" width={width} marginTop={1}>
      <Box paddingX={1}>
        {badge ? (
          <>
            <Text color={badge.c} bold>{badge.text}</Text>
            <Text color={shellMode ? color.shell : color.faint}>{glyph.rule.repeat(Math.max(width - 2 - badge.text.length, 4))}</Text>
          </>
        ) : (
          <Text color={color.faint}>{glyph.rule.repeat(Math.max(width - 2, 8))}</Text>
        )}
      </Box>
      {value === "" ? (
        // Empty composer: idle placeholder. While busy, the cue is "type to queue".
        <Box paddingX={1}>
          <Text color={busy ? color.faint : accent} bold backgroundColor={color.panelBg}>
            {glyph.prompt}{" "}
          </Text>
          {!busy ? <Text inverse backgroundColor={color.panelBg}> </Text> : null}
          <Text color={color.faint} backgroundColor={color.panelBg}>{busy ? "type to queue · esc interrupts" : suggestion ?? placeholder}</Text>
        </Box>
      ) : (
        // Non-empty: render the live editable input WITH the cursor, even while
        // busy — what you type queues and sends when the turn finishes.
        <Box flexDirection="column" paddingX={1}>
          {lines.map((ln, i) => (
            <Box key={i}>
              <Text color={accent} bold backgroundColor={color.panelBg}>{prefix(i)}</Text>
              {renderLine(ln, i)}
            </Box>
          ))}
          {busy ? (
            <Text color={color.faint}>↵ queues · sends when the current turn finishes</Text>
          ) : shellMode ? (
            <Text color={color.faint}>↵ runs in your shell</Text>
          ) : null}
        </Box>
      )}
    </Box>
  );
}
