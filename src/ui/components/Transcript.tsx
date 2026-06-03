import React from "react";
import { Box, Text } from "ink";
import { color, glyph } from "../theme.ts";
import type { Item } from "../types.ts";
import { Markdown } from "./Markdown.tsx";

const DIFF_MAX = 16;

function DiffView({ lines }: { lines: { sign: "+" | "-"; text: string }[] }) {
  const shown = lines.slice(0, DIFF_MAX);
  const extra = lines.length - shown.length;
  return (
    <Box flexDirection="column" marginLeft={5} marginTop={1}>
      {shown.map((l, i) => (
        <Text key={i} color={l.sign === "+" ? color.ok : color.err}>
          {l.sign === "+" ? "+" : "−"} {l.text}
        </Text>
      ))}
      {extra > 0 ? <Text color={color.faint}>… +{extra} more lines</Text> : null}
    </Box>
  );
}

// Your turn: a colored quarter-block spine, no prompt glyph.
function UserLine({ text }: { text: string }) {
  return (
    <Box marginTop={1}>
      <Text color={color.user}>{glyph.userBar} </Text>
      <Box flexGrow={1}>
        <Text color={color.user}>{text}</Text>
      </Box>
    </Box>
  );
}

// The reply: clean prose, indented, no marker — it reads as the open response.
function AssistantLine({ text, width }: { text: string; width: number }) {
  if (!text) return null;
  const prose = Math.max(width - 4, 20);
  return (
    <Box marginTop={1} marginLeft={2} flexDirection="column">
      <Markdown text={text} width={prose} />
    </Box>
  );
}

// Tool call: `⏺ name  arg`, status carried by the circle's COLOR (accent ok,
// coral failed), with the result on a `⎿` continuation line.
function ToolLine({ item }: { item: Extract<Item, { kind: "tool" }> }) {
  const dotColor = item.status === "err" ? color.err : color.accent;
  return (
    <Box flexDirection="column" marginLeft={2} marginTop={1}>
      <Box>
        <Text color={dotColor}>{glyph.tool}</Text>
        <Text color={color.dim}>{"  " + item.name.padEnd(5)}</Text>
        {item.arg ? <Text color={color.text}>{" " + item.arg}</Text> : null}
        {item.status === "running" ? <Text color={color.faint}>{"  …"}</Text> : null}
      </Box>
      {item.status === "running" && item.stream ? (
        <Box marginLeft={1} flexDirection="column">
          {item.streamCount && item.streamCount > 14 ? <Text color={color.faint}>{`… writing ${item.streamCount} lines`}</Text> : null}
          {item.stream.split("\n").slice(-14).map((l, i) => (
            <Text key={i} color={color.ok}>{`+ ${l}`}</Text>
          ))}
        </Box>
      ) : null}
      {item.status !== "running" && item.summary ? (
        <Box marginLeft={1}>
          <Text color={color.faint}>{glyph.result} </Text>
          <Box flexGrow={1}>
            <Text color={item.status === "err" ? color.err : color.dim}>{item.summary}</Text>
          </Box>
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
              <Box key={it.id} marginTop={1} marginLeft={2}>
                <Text color={color.accentDim}>{glyph.notice} </Text>
                <Box flexGrow={1}>
                  <Text color={color.dim}>{it.text}</Text>
                </Box>
              </Box>
            );
          case "error":
            return (
              <Box key={it.id} marginTop={1} marginLeft={2}>
                <Text color={color.err}>{glyph.err} </Text>
                <Box flexGrow={1}>
                  <Text color={color.err}>{it.text}</Text>
                </Box>
              </Box>
            );
        }
      })}
    </Box>
  );
}
