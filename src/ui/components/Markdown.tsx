import React from "react";
import { Box, Text } from "ink";
import { marked } from "marked";
import { color, glyph } from "../theme.ts";
import { highlightLine } from "../highlight.ts";
import { PROSE_RE, proseTokenStyle } from "../prose.ts";

// Parse with marked (battle-tested), render with Ink (full control, no foreign
// ANSI fighting Ink's layout). marked handles headings, lists, tables, code,
// blockquotes, nesting; we map its tokens to Ink elements.

const decode = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

const visibleLen = (s: string) => decode(s).length;

const codeLineRe =
  /^(\s{2,}\S|from\s+|import\s+|class\s+|def\s+|async\s+def\s+|@\w|if\s+|elif\s+|else:|for\s+|while\s+|try:|except\s+|finally:|with\s+|return\s+|[A-Za-z_][\w.]*\s*=|[A-Za-z_][\w.]*\(|"""|'''|\/\/|#include\b|const\s+|let\s+|var\s+|function\s+|type\s+|interface\s+|export\s+|package\s+|func\s+)/;

function looksLikeLooseCode(text: string): boolean {
  const lines = decode(text).split("\n").filter((l) => l.trim());
  if (lines.length < 2) return false;
  const hits = lines.filter((l) => codeLineRe.test(l.trimStart() === l ? l.trim() : l)).length;
  if (lines.length === 2) return hits === 2;
  return hits / lines.length >= 0.55;
}

function guessCodeLang(text: string): string {
  if (/^\s*(from|import|def|class|@dataclass)\b/m.test(text)) return "python";
  if (/^\s*(const|let|var|function|type|interface|export|import)\b/m.test(text)) return "ts";
  if (/^\s*(package|func)\b/m.test(text)) return "go";
  return "";
}

const spansLen = (spans: { text: string }[]) => spans.reduce((n, s) => n + s.text.length, 0);

function diffRow(line: string, lang: string): { sign: string; code: string; bg: string; fg: string; lang: string } {
  const isDiff = /^(diff|patch)$/i.test(lang);
  if ((isDiff || /^[+-]/.test(line)) && line.startsWith("+") && !line.startsWith("+++")) {
    return { sign: "+", code: line.slice(1), bg: color.diffAddBg, fg: color.ok, lang: "" };
  }
  if ((isDiff || /^[+-]/.test(line)) && line.startsWith("-") && !line.startsWith("---")) {
    return { sign: "−", code: line.slice(1), bg: color.diffDelBg, fg: color.err, lang: "" };
  }
  return { sign: "", code: line, bg: color.codeBg, fg: color.faint, lang };
}

function RichText({ text, baseColor = color.text }: { text: string; baseColor?: string }) {
  const decoded = decode(text);
  const out: React.ReactNode[] = [];
  // Prose highlighting via the shared tokenizer (prose.ts) — same tokens + styles
  // as the fullscreen path (proseSpans in lines.ts), so the two never drift.
  let last = 0;
  let key = 0;
  for (const m of decoded.matchAll(PROSE_RE)) {
    const idx = m.index ?? 0;
    const raw = m[0]!;
    const leading = raw.match(/^\s+/)?.[0] ?? "";
    const token = raw.slice(leading.length);
    if (idx > last) out.push(<Text key={key++} color={baseColor}>{decoded.slice(last, idx)}</Text>);
    if (leading) out.push(<Text key={key++} color={baseColor}>{leading}</Text>);
    const st = proseTokenStyle(token);
    out.push(<Text key={key++} color={st.color} bold={st.bold} backgroundColor={st.bg}>{token}</Text>);
    last = idx + raw.length;
  }
  if (last < decoded.length) out.push(<Text key={key++} color={baseColor}>{decoded.slice(last)}</Text>);
  return <>{out.length ? out : <Text color={baseColor}>{decoded}</Text>}</>;
}

// ---- inline ----
function Inline({ tokens }: { tokens: any[] }): React.ReactElement {
  return (
    <>
      {(tokens ?? []).map((t, i) => {
        switch (t.type) {
          case "strong":
            return (
              <Text key={i} bold color={color.text}>
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
            // Color only, no background box (keeps dense `identifier`-heavy prose
            // calm) — mirrors the fullscreen lines.ts codespan path. Path-blue, not
            // the bright accent: accent is reserved for interactive/now.
            return (
              <Text key={i} color={color.path}>
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
            return t.tokens ? <Inline key={i} tokens={t.tokens} /> : <RichText key={i} text={t.text} />;
          default:
            return <RichText key={i} text={t.text ?? t.raw ?? ""} />;
        }
      })}
    </>
  );
}

// ---- code block (Ink-native syntax highlighting via styled spans) ----
function CodeBlock({ lang, code, width }: { lang: string; code: string; width: number }) {
  const lines = decode(code).replace(/\n$/, "").split("\n");
  const lineNoWidth = Math.max(2, String(lines.length).length);
  const contentWidth = Math.max(
    24,
    Math.min(
      Math.max(24, width - 4),
      Math.max(40, ...lines.map((l) => lineNoWidth + 3 + visibleLen(l)), lang ? visibleLen(lang) + 2 : 0),
    ),
  );
  const renderPaddedLine = (key: React.Key, spans: React.ReactNode[], used: number, bg = color.codeBg) => (
    <Text key={key}>
      {spans}
      <Text backgroundColor={bg}>{" ".repeat(Math.max(0, contentWidth - used))}</Text>
    </Text>
  );
  return (
    <Box flexDirection="column" marginY={1} paddingX={1} borderStyle="single" borderColor={color.accentDim}>
      {/* Single-paint lang row: one Text span carries the pre-padded label, so
          the row is one background pass (no label chip + pad seam). */}
      {lang ? (
        <Text key="lang">
          <Text color={color.accentDim} bold backgroundColor={color.codeBg}>{` ${lang} `.padEnd(contentWidth).slice(0, Math.max(contentWidth, visibleLen(lang) + 2))}</Text>
        </Text>
      ) : null}
      {lines.map((l, i) => {
        const row = diffRow(l, lang);
        const gutter = `${row.sign || " "} ${String(i + 1).padStart(lineNoWidth)} `;
        const sep = "│ "; // structure, not accent — always faint
        const highlighted = highlightLine(row.code, row.lang);
        const isBlank = row.code.trim() === "";
        if (isBlank) {
          // Blank lines get the prefix only · no trailing background band.
          return (
            <Text key={i}>
              <Text color={color.faint} backgroundColor={row.bg}>{gutter}</Text>
              <Text color={color.faint} backgroundColor={row.bg}>{sep}</Text>
            </Text>
          );
        }
        return renderPaddedLine(
          i,
          [
            <Text key="gutter" color={row.sign ? row.fg : color.faint} bold={Boolean(row.sign)} backgroundColor={row.bg}>{gutter}</Text>,
            <Text key="sep" color={color.faint} backgroundColor={row.bg}>{sep}</Text>,
            ...highlighted.map((s, j) => (
              <Text key={j} color={s.color} bold={s.bold} dimColor={s.dim} backgroundColor={row.bg}>{s.text}</Text>
            )),
          ],
          gutter.length + sep.length + spansLen(highlighted),
          row.bg,
        );
      })}
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
            <Text color={color.text} bold={bold} wrap="wrap">
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
          <Text color={color.accentDim} bold>{token.ordered ? `${start + i}. ` : "· "}</Text>
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
      if (looksLikeLooseCode(token.text ?? token.raw ?? "")) {
        const text = token.text ?? token.raw ?? "";
        return <CodeBlock lang={guessCodeLang(text)} code={text} width={width} />;
      }
      return (
        <Text wrap="wrap" color={color.text}>
          <Inline tokens={token.tokens} />
        </Text>
      );
    case "text":
      if (looksLikeLooseCode(token.text ?? token.raw ?? "")) {
        const text = token.text ?? token.raw ?? "";
        return <CodeBlock lang={guessCodeLang(text)} code={text} width={width} />;
      }
      return token.tokens ? (
        <Text wrap="wrap" color={color.text}>
          <Inline tokens={token.tokens} />
        </Text>
      ) : (
        <Text wrap="wrap" color={color.text}>{decode(token.text ?? "")}</Text>
      );
    case "hr":
      return <Text color={color.faint}>{"─".repeat(Math.min(width, 24))}</Text>;
    case "code":
      return <CodeBlock lang={token.lang ?? ""} code={token.text ?? ""} width={width} />;
    case "list":
      return <ListBlock token={token} width={width} />;
    case "table":
      return <Table token={token} width={width} />;
    case "blockquote":
      return (
        <Box flexDirection="row">
          <Text color={color.accentDim}>{glyph.quote} </Text>
          <Box flexDirection="column">
            <Blocks tokens={token.tokens} width={width - 2} />
          </Box>
        </Box>
      );
    default:
      return token.text ? <Text wrap="wrap" color={color.text}>{decode(token.text)}</Text> : null;
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
    return <Text wrap="wrap" color={color.text}>{text}</Text>;
  }
  return <Blocks tokens={tokens} width={width} />;
}
