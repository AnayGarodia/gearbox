import React from "react";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { color, glyph } from "../theme.ts";
import type { Item } from "../types.ts";
import { Markdown } from "./Markdown.tsx";

const DIFF_MAX = 16;

function DiffView({ lines }: { lines: { sign: "+" | "-"; text: string }[] }) {
  const shown = lines.slice(0, DIFF_MAX);
  const extra = lines.length - shown.length;
  return (
    <Box flexDirection="column" marginLeft={2} marginTop={1}>
      {shown.map((l, i) => (
        <Text key={i} color={l.sign === "+" ? color.ok : color.err}>
          {l.sign} {l.text}
        </Text>
      ))}
      {extra > 0 ? <Text color={color.faint}>… +{extra} more lines</Text> : null}
    </Box>
  );
}

function UserLine({ text }: { text: string }) {
  return (
    <Box marginTop={1}>
      <Text color={color.user} bold>
        {glyph.user}{" "}
      </Text>
      <Text color={color.user}>{text}</Text>
    </Box>
  );
}

function AssistantLine({ text, width }: { text: string; width: number }) {
  if (!text) return null;
  return (
    <Box marginTop={1}>
      <Text color={color.accent}>{glyph.assistant} </Text>
      <Box flexGrow={1} flexDirection="column">
        <Markdown text={text} width={Math.max(width - 4, 20)} />
      </Box>
    </Box>
  );
}

function ToolLine({ item }: { item: Extract<Item, { kind: "tool" }> }) {
  return (
    <Box flexDirection="column" marginLeft={2} marginTop={1}>
      {item.status === "running" ? (
        <Box>
          <Spinner label={`${item.name}${item.arg ? "  " + item.arg : ""}`} />
        </Box>
      ) : (
        <Box>
          <Text color={item.status === "ok" ? color.ok : color.err}>
            {item.status === "ok" ? glyph.ok : glyph.err}
          </Text>
          <Text color={color.accentDim}> {item.name}</Text>
          {item.arg ? <Text color={color.dim}>{"  " + item.arg}</Text> : null}
        </Box>
      )}
      {item.status !== "running" && item.summary ? (
        <Box marginLeft={2}>
          <Text color={color.faint}>{item.summary}</Text>
        </Box>
      ) : null}
      {item.diff && item.diff.length > 0 ? <DiffView lines={item.diff} /> : null}
    </Box>
  );
}

export function Transcript({ items, width = 80 }: { items: Item[]; width?: number }) {
  return (
    <Box flexDirection="column" paddingX={1}>
      {items.map((it) => {
        switch (it.kind) {
          case "user":
            return <UserLine key={it.id} text={it.text} />;
          case "assistant":
            return <AssistantLine key={it.id} text={it.text} width={width} />;
          case "tool":
            return <ToolLine key={it.id} item={it} />;
          case "notice":
            return (
              <Box key={it.id} marginTop={1}>
                <Text color={color.accentDim}>{glyph.notice} </Text>
                <Box flexGrow={1}>
                  <Text color={color.dim}>{it.text}</Text>
                </Box>
              </Box>
            );
          case "error":
            return (
              <Box key={it.id} marginTop={1}>
                <Text color={color.err}>
                  {glyph.err} {it.text}
                </Text>
              </Box>
            );
        }
      })}
    </Box>
  );
}
