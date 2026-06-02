import React from "react";
import { Box, Text } from "ink";
import { marked } from "marked";
import { color } from "../theme.ts";

// Parse with marked (battle-tested), render with Ink (full control, no foreign
// ANSI fighting Ink's layout). marked handles headings, lists, tables, code,
// blockquotes, nesting; we map its tokens to Ink elements.

const decode = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

const visibleLen = (s: string) => decode(s).length;

// ---- inline ----
function Inline({ tokens }: { tokens: any[] }): React.ReactElement {
  return (
    <>
      {(tokens ?? []).map((t, i) => {
        switch (t.type) {
          case "strong":
            return (
              <Text key={i} bold>
                <Inline tokens={t.tokens} />
              </Text>
            );
          case "em":
            return (
              <Text key={i} italic>
                <Inline tokens={t.tokens} />
              </Text>
            );
          case "del":
            return (
              <Text key={i} strikethrough>
                <Inline tokens={t.tokens} />
              </Text>
            );
          case "codespan":
            return (
              <Text key={i} color={color.accent}>
                {decode(t.text)}
              </Text>
            );
          case "link":
            return (
              <Text key={i} color={color.user} underline>
                {decode(t.text)}
              </Text>
            );
          case "br":
            return <Text key={i}>{"\n"}</Text>;
          case "text":
            return t.tokens ? <Inline key={i} tokens={t.tokens} /> : <Text key={i}>{decode(t.text)}</Text>;
          default:
            return <Text key={i}>{decode(t.text ?? t.raw ?? "")}</Text>;
        }
      })}
    </>
  );
}

// ---- code block (Ink-native; syntax highlight can be added later as spans) ----
function CodeBlock({ lang, code }: { lang: string; code: string }) {
  return (
    <Box flexDirection="column" marginY={1} paddingX={1} borderStyle="round" borderColor={color.faint}>
      {lang ? <Text color={color.faint}>{lang}</Text> : null}
      <Text color={color.text}>{decode(code).replace(/\n$/, "")}</Text>
    </Box>
  );
}

// ---- table (aligned columns, wrapping; header bold + underline) ----
function Table({ token, width }: { token: any; width: number }) {
  const header: any[] = token.header ?? [];
  const rows: any[][] = token.rows ?? [];
  const cols = header.length || 1;
  const gap = 2;
  const natural = header.map((h, c) => Math.max(visibleLen(h.text ?? ""), ...rows.map((r) => visibleLen(r[c]?.text ?? "")), 3));
  const avail = Math.max(cols * 4, width - (cols - 1) * gap);
  const total = natural.reduce((a, b) => a + b, 0);
  const widths = total <= avail ? natural : natural.map((w) => Math.max(6, Math.floor((avail * w) / total)));
  const tableWidth = widths.reduce((a, b) => a + b, 0) + (cols - 1) * gap;

  const Row = ({ cells, bold }: { cells: any[]; bold?: boolean }) => (
    <Box flexDirection="row">
      {widths.map((w, c) => (
        <React.Fragment key={c}>
          {c > 0 ? <Text>{"  "}</Text> : null}
          <Box width={w}>
            <Text color={bold ? color.accent : color.text} bold={bold} wrap="wrap">
              <Inline tokens={cells[c]?.tokens ?? []} />
            </Text>
          </Box>
        </React.Fragment>
      ))}
    </Box>
  );

  return (
    <Box flexDirection="column" marginY={1}>
      <Row cells={header} bold />
      <Text color={color.faint}>{"─".repeat(Math.min(tableWidth, width))}</Text>
      {rows.map((r, i) => (
        <Row key={i} cells={r} />
      ))}
    </Box>
  );
}

function ListBlock({ token, width }: { token: any; width: number }) {
  const start = typeof token.start === "number" ? token.start : 1;
  return (
    <Box flexDirection="column">
      {(token.items ?? []).map((item: any, i: number) => (
        <Box key={i} flexDirection="row">
          <Text color={color.dim}>{token.ordered ? `${start + i}. ` : "• "}</Text>
          <Box flexDirection="column">
            <Blocks tokens={item.tokens} width={width - 3} />
          </Box>
        </Box>
      ))}
    </Box>
  );
}

// ---- block dispatch ----
function Block({ token, width }: { token: any; width: number }): React.ReactElement | null {
  switch (token.type) {
    case "space":
      return null;
    case "heading":
      return (
        <Text bold color={color.accent}>
          <Inline tokens={token.tokens} />
        </Text>
      );
    case "paragraph":
      return (
        <Text wrap="wrap">
          <Inline tokens={token.tokens} />
        </Text>
      );
    case "text":
      return token.tokens ? (
        <Text wrap="wrap">
          <Inline tokens={token.tokens} />
        </Text>
      ) : (
        <Text wrap="wrap">{decode(token.text ?? "")}</Text>
      );
    case "hr":
      return <Text color={color.faint}>{"─".repeat(Math.min(width, 48))}</Text>;
    case "code":
      return <CodeBlock lang={token.lang ?? ""} code={token.text ?? ""} />;
    case "list":
      return <ListBlock token={token} width={width} />;
    case "table":
      return <Table token={token} width={width} />;
    case "blockquote":
      return (
        <Box flexDirection="row">
          <Text color={color.faint}>│ </Text>
          <Box flexDirection="column">
            <Blocks tokens={token.tokens} width={width - 2} />
          </Box>
        </Box>
      );
    default:
      return token.text ? <Text wrap="wrap">{decode(token.text)}</Text> : null;
  }
}

function Blocks({ tokens, width }: { tokens: any[]; width: number }) {
  return (
    <Box flexDirection="column">
      {(tokens ?? []).map((t, i) => (
        <Block key={i} token={t} width={width} />
      ))}
    </Box>
  );
}

export function Markdown({ text, width = 80 }: { text: string; width?: number }) {
  let tokens: any[];
  try {
    tokens = marked.lexer(text);
  } catch {
    return <Text wrap="wrap">{text}</Text>;
  }
  return <Blocks tokens={tokens} width={width} />;
}
