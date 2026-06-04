import React, { useRef, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { color, glyph } from "../theme.ts";
import { caretPos, selectionRange, type Edit } from "../input.ts";
import { mouseEventToAction } from "../terminal.ts";

// Borderless composer: a hairline rule, then a `❯` prompt with the input and a
// terminal-native block cursor (`inverse`). Multi-line aware — continuation lines
// align under the prompt and the cursor lands on the right row/column. No box.
export function Composer({
  value,
  cursor,
  selectionAnchor,
  placeholder,
  busy,
  width,
  vim = "off",
  onEdit,
}: {
  value: string;
  cursor: number;
  selectionAnchor?: number;
  placeholder: string;
  busy: boolean;
  width: number;
  vim?: "off" | "insert" | "normal";
  onEdit?: (edit: Edit) => void;
}) {
  // ── Mouse‑selection hook ────────────────────────────────────────────────
  const lastClick = useRef<{ time: number; x: number; y: number; count?: number } | null>(null);

  const handleMouse = useCallback(
    (raw: { button: number; x: number; y: number; shift: boolean; meta: boolean; ctrl: boolean }) => {
      if (!onEdit) return;
      const now = Date.now();
      const prev = lastClick.current;
      let count = 1;
      if (prev && now - prev.time < 500 && prev.x === raw.x && prev.y === raw.y) {
        count = Math.min(prev.count ?? 1, 3) + 1;
      }
      lastClick.current = { time: now, x: raw.x, y: raw.y, count };
      const action = mouseEventToAction(
        { value, cursor, selectionAnchor },
        raw,
        count,
      );
      if (action.type === "edit") {
        onEdit(action.state);
      }
    },
    [value, cursor, selectionAnchor, onEdit],
  );

  useInput(
    (_input: string, key: any) => {
      // Mouse events come through `key.mouse` when `mouse` is enabled.
      if (key.mouse) {
        handleMouse(key.mouse);
      }
    },
    { isActive: true, mouse: "all" },
  );

  // ── Mouse‑selection hook ────────────────────────────────────────────────
  const lastClick = useRef<{ time: number; x: number; y: number; count?: number } | null>(null);

  const handleMouse = useCallback(
    (raw: { button: number; x: number; y: number; shift: boolean; meta: boolean; ctrl: boolean }) => {
      if (!onEdit) return;
      const now = Date.now();
      const prev = lastClick.current;
      let count = 1;
      if (prev && now - prev.time < 500 && prev.x === raw.x && prev.y === raw.y) {
        count = Math.min(prev.count ?? 1, 3) + 1;
      }
      lastClick.current = { time: now, x: raw.x, y: raw.y, count };
      const action = mouseEventToAction(
        { value, cursor, selectionAnchor },
        raw,
        count,
      );
      if (action.type === "edit") {
        onEdit(action.state);
      }
    },
    [value, cursor, selectionAnchor, onEdit],
  );

  useInput(
    (_input: string, key: any) => {
      // Mouse events come through `key.mouse` when `mouse` is enabled.
      if (key.mouse) {
        handleMouse(key.mouse);
      }
    },
    { isActive: true, mouse: "all" },
  );

  const lines = value.split("\n");
  const { lineIdx: curLine, col: curCol } = caretPos(value, cursor);
  const selected = selectionRange({ value, cursor, selectionAnchor });
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

  return (
    <Box flexDirection="column" width={width} marginTop={1}>
      <Box paddingX={1}>
        {vim !== "off" ? (
          <>
            <Text color={vim === "normal" ? color.accent : color.dim} bold>{vim === "normal" ? " NORMAL " : " INSERT "}</Text>
            <Text color={color.faint}>{glyph.rule.repeat(Math.max(width - 11, 4))}</Text>
          </>
        ) : (
          <Text color={color.faint}>{glyph.rule.repeat(Math.max(width - 2, 8))}</Text>
        )}
      </Box>
      {busy ? (
        <Box paddingX={1}>
          <Text color={color.faint} bold>
            {glyph.prompt}{" "}
          </Text>
          <Text color={color.faint}>{value || "…"}</Text>
        </Box>
      ) : value === "" ? (
        <Box paddingX={1}>
          <Text color={color.accent} bold>
            {glyph.prompt}{" "}
          </Text>
          <Text inverse> </Text>
          <Text color={color.faint}>{placeholder}</Text>
        </Box>
      ) : (
        <Box flexDirection="column" paddingX={1}>
          {lines.map((ln, i) => (
            <Box key={i}>
              <Text color={color.accent} bold>{prefix(i)}</Text>
              {renderLine(ln, i)}
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
