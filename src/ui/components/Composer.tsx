import React from "react";
import { Box, Text } from "ink";
import { color, glyph } from "../theme.ts";
import { caretPos, selectionRange, type Edit } from "../input.ts";

// Input box: a single accent-coloured LEFT BAR (the one "now" accent) running the
// height of the box, a hairline rule, a policy/branch info line, then a `❯` prompt
// with the input and a terminal-native block cursor (`inverse`). Multi-line aware ·
// continuation lines align under the prompt and the cursor lands on the right
// row/column. The left bar takes 1 column (innerWidth = width − 1).
// Memoized (export at the bottom): its props (value/cursor/placeholder/…, all
// primitives) don't change while scrolling or streaming, so it skips re-rendering
// on those frames.
function ComposerImpl({
  value,
  cursor,
  selectionAnchor,
  placeholder,
  suggestion,
  busy,
  width,
  vim = "off",
  bashMode = false,
  policy,
  branch,
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
  bashMode?: boolean; // sticky bash mode (entered with `!`); pink `!` prompt, esc exits
  policy?: string; // routing policy shown in the box (e.g. "auto-route"); never a bare model name
  branch?: string | null; // current git branch, shown after the policy
  onEdit?: (edit: Edit) => void;
}) {
  const lines = value.split("\n");
  const { lineIdx: curLine, col: curCol } = caretPos(value, cursor);
  const selected = selectionRange({ value, cursor, selectionAnchor });
  // Shell mode: a leading `!` (or sticky bash mode) runs the line as a shell
  // command. A distinct pink accent + `!` prompt so it never reads as chat/command.
  const shellMode = bashMode || value.startsWith("!");
  const accent = shellMode ? color.shell : color.accent;
  const promptGlyph = bashMode ? "!" : glyph.prompt;
  const prefix = (i: number) => (i === 0 ? promptGlyph + " " : "  ");
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
      if (!cursorHere) return <Text>{ln}</Text>;
      return (
        <Text>
          {ln.slice(0, curCol)}
          <Text inverse>{ln[curCol] ?? " "}</Text>
          {ln.slice(curCol + 1)}
        </Text>
      );
    }
    return (
      <Text>
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

  // The box owns a single left border in the live accent (pink in bash mode). Only
  // the left edge is drawn, so it reads as one calm vertical bar; the border eats 1
  // column, so the inner rule spans width − 3 (1 border + 2 paddingX).
  return (
    <Box
      flexDirection="column"
      width={width}
      marginTop={1}
      borderStyle="single"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderLeft={true}
      borderLeftColor={accent}
    >
      <Box paddingX={1}>
        {badge ? (
          <>
            <Text color={badge.c} bold>{badge.text}</Text>
            <Text color={shellMode ? color.shell : color.faint}>{glyph.rule.repeat(Math.max(width - 3 - badge.text.length, 4))}</Text>
          </>
        ) : (
          <Text color={color.faint}>{glyph.rule.repeat(Math.max(width - 3, 8))}</Text>
        )}
      </Box>
      {/* Policy + branch: intent for this turn, not a model name. Dim by design —
          the work is the focus, this is quiet chrome. */}
      {policy ? (
        <Box paddingX={1}>
          <Text color={color.dim}>{policy}</Text>
          {branch ? <Text color={color.faint}>{`  ${glyph.bullet}  ${glyph.branch} ${branch}`}</Text> : null}
        </Box>
      ) : null}
      {value === "" ? (
        // Empty composer: idle placeholder. While busy, the cue is "type to queue".
        <Box paddingX={1}>
          <Text color={busy ? color.faint : accent} bold>
            {promptGlyph}{" "}
          </Text>
          {!busy ? <Text inverse> </Text> : null}
          <Text color={color.faint}>{busy ? "type to queue · esc interrupts" : bashMode ? "shell command · esc to exit bash mode" : suggestion ?? placeholder}</Text>
        </Box>
      ) : (
        // Non-empty: render the live editable input WITH the cursor, even while
        // busy — what you type queues and sends when the turn finishes.
        <Box flexDirection="column" paddingX={1}>
          {lines.map((ln, i) => (
            <Box key={i}>
              <Text color={accent} bold>{prefix(i)}</Text>
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

export const Composer = React.memo(ComposerImpl);
