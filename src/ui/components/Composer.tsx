import React from "react";
import { Box, Text } from "ink";
import { color, glyph } from "../theme.ts";
import { caretPos, selectionRange, type Edit } from "../input.ts";

// The opencode editor look: the input sits on the element layer (color.elementBg)
// between a thick LEFT and RIGHT edge (┃) in a quiet border gray, with a bold `❯`
// prompt in the accent. Bash mode keeps the pink `!` prompt + shell-colored edges.
// Under the box, ONE footer hint line: contextual hint left (`⏎ send` idle /
// `working ⋯ esc interrupt` while busy, plus the routing policy + branch, dim),
// provider (dim) + model (bold) right.
//
// ROW-COUNT CONTRACT (coupled · keep in lockstep): the block is
//   marginTop(1) + input rows(N) + footer hint(1) + marginBottom(lift ? 1 : 0).
// App.tsx's footer estimate budgets this as a flat 4 (N estimated at 1) and
// statusBarHit's `chrome` constant in StatusBar.tsx assumes 3 chrome rows
// (marginTop + footer hint + marginBottom) around the N input rows.
//
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
  provider,
  model,
  lift = false,
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
  policy?: string; // routing policy shown on the footer line (e.g. "auto-route"); never a bare model name
  branch?: string | null; // current git branch, shown after the policy
  provider?: string | null; // footer-right: the live provider (dim)
  model?: string | null; // footer-right: the live model name (bold)
  lift?: boolean; // fullscreen only: a 1-row bottom margin so the input sits off the screen's bottom edge. Inline has no edge to lift off (the terminal owns the rows below), so it stays flush — no stray trailing blank.
  onEdit?: (edit: Edit) => void;
}) {
  const lines = value.split("\n");
  const { lineIdx: curLine, col: curCol } = caretPos(value, cursor);
  const selected = selectionRange({ value, cursor, selectionAnchor });
  // Shell mode: a leading `!` (or sticky bash mode) runs the line as a shell
  // command. A distinct pink accent + `!` prompt so it never reads as chat/command.
  const shellMode = bashMode || value.startsWith("!");
  const accent = shellMode ? color.shell : color.accent;
  const edge = shellMode ? color.shell : color.faint;
  const promptGlyph = bashMode ? "!" : glyph.prompt;
  // Columns inside the two ┃ edges; each row is padded to this so the element
  // layer reads as one solid surface, not text-shaped patches.
  const innerW = Math.max(width - 2, 8);
  const prefix = (i: number) => (i === 0 ? " " + promptGlyph + " " : "   ");
  const bgPad = (used: number) => (used < innerW ? <Text backgroundColor={color.elementBg}>{" ".repeat(innerW - used)}</Text> : null);
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
      if (!cursorHere) return <Text color={color.text}>{ln}</Text>;
      return (
        <Text color={color.text}>
          {ln.slice(0, curCol)}
          <Text inverse>{ln[curCol] ?? " "}</Text>
          {ln.slice(curCol + 1)}
        </Text>
      );
    }
    return (
      <Text color={color.text}>
        {ln.slice(0, selStart)}
        <Text inverse>{ln.slice(selStart, selEnd)}</Text>
        {ln.slice(selEnd)}
      </Text>
    );
  };
  // Columns a rendered input row occupies (the cursor block past the line end
  // adds one), so the element-bg padding fills exactly to the right edge.
  const usedCols = (ln: string, line: number) =>
    prefix(line).length + ln.length + (line === curLine && curCol >= ln.length ? 1 : 0);

  // Footer hint (left): mode badge first (bash/vim), then the contextual hint,
  // then the quiet policy + branch. One line, always present.
  const badge = shellMode
    ? { text: "! bash", c: color.shell }
    : vim === "normal"
    ? { text: "NORMAL", c: color.accent }
    : vim === "insert"
    ? { text: "INSERT", c: color.dim }
    : null;
  const hint = busy
    ? value !== ""
      ? "⏎ queues · sends when the current turn finishes"
      : "type to queue" // the now-row above already carries elapsed + esc — say it once
    : shellMode
    ? "⏎ runs in your shell"
    : "⏎ send";

  return (
    // flexShrink=0: when the frame is over-full, Yoga must squeeze the flexible
    // transcript/hero region — never the input box (a shrunk border box paints
    // its footer over the input row).
    <Box flexDirection="column" width={width} marginTop={1} marginBottom={lift ? 1 : 0} flexShrink={0}>
      {/* The editor box: thick left + right edges only, element-layer rows inside. */}
      <Box
        flexDirection="column"
        width={width}
        borderStyle="bold"
        borderTop={false}
        borderBottom={false}
        borderLeft={true}
        borderRight={true}
        borderLeftColor={edge}
        borderRightColor={edge}
      >
        {/* vertical padding: the editor is a place, not a slit — two element-bg
            breathing rows (row contract: composer block = marginTop + pad +
            input rows + pad + footer hint · App.tsx footer estimate). */}
        <Box width={innerW}>{bgPad(0)}</Box>
        {value === "" ? (
          // Empty composer: idle placeholder. While busy, the cue is "type to queue".
          <Box width={innerW}>
            <Text backgroundColor={color.elementBg}>
              <Text color={busy ? color.faint : accent} bold>{" " + promptGlyph + " "}</Text>
              {!busy ? <Text inverse> </Text> : null}
              <Text color={color.faint}>{busy ? "" : bashMode ? "shell command · esc exits bash mode" : suggestion ?? placeholder}</Text>
            </Text>
            {bgPad(3 + (busy ? 0 : 1) + (busy ? "" : bashMode ? "shell command · esc exits bash mode" : suggestion ?? placeholder).length)}
          </Box>
        ) : (
          // Non-empty: render the live editable input WITH the cursor, even while
          // busy — what you type queues and sends when the turn finishes.
          <Box flexDirection="column" width={innerW}>
            {lines.map((ln, i) => (
              <Box key={i} width={innerW}>
                <Text backgroundColor={color.elementBg}>
                  <Text color={accent} bold>{prefix(i)}</Text>
                  {renderLine(ln, i)}
                </Text>
                {bgPad(usedCols(ln, i))}
              </Box>
            ))}
          </Box>
        )}
        <Box width={innerW}>{bgPad(0)}</Box>
      </Box>
      {/* THE footer hint line (exactly one row · see the row-count contract above). */}
      <Box width={width} paddingX={1} justifyContent="space-between">
        <Text wrap="truncate-end">
          {badge ? <Text color={badge.c} bold>{badge.text + "  "}</Text> : null}
          <Text color={color.faint}>{hint}</Text>
          {policy ? <Text color={color.dim}>{`  ${glyph.bullet}  ${policy}`}</Text> : null}
        </Text>
        {provider || model ? (
          <Text wrap="truncate-end">
            {provider ? <Text color={color.dim}>{provider + " "}</Text> : null}
            {model ? <Text color={color.text} bold>{model}</Text> : null}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}

export const Composer = React.memo(ComposerImpl);
