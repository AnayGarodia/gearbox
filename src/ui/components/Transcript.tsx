import React from "react";
import { Box, Text, Static } from "ink";
import { color, glyph } from "../theme.ts";
import { limitColor } from "../severity.ts";
import { friendlyTool, relPath, fmtElapsed } from "../lines.ts";
import type { Item } from "../types.ts";
import { Markdown } from "./Markdown.tsx";
import { highlightLine } from "../highlight.ts";
import { barCells, type UsageView } from "../../accounts/usage.ts";
import type { AccountView, ContextView } from "../types.ts";
import { scorecardRows } from "../../commands.ts";
import type { Scorecard } from "../../model/selector.ts";

// Limit-utilization color: green when there's headroom, accent mid, coral when
// you're nearly maxed (≥85%) so it reads as a warning.

function Bar({ frac, width, on }: { frac: number; width: number; on: string }) {
  const { fill, empty } = barCells(frac, width);
  return (
    <Text>
      <Text color={on}>{fill}</Text>
      <Text color={color.faint}>{empty}</Text>
    </Text>
  );
}

// The /usage card, split by account type. Subscriptions (flat fee) show a
// rate-limit bar · the metric that matters there; API keys (pay-per-token) show
// dollars spent. Same data as the fullscreen path (lines.ts).
function UsageCard({ view }: { view: UsageView }) {
  const { labelPad, spendPad } = view;
  return (
    <Box flexDirection="column" marginTop={1} marginLeft={2}>
      <Box>
        <Text color={color.accentDim}>{glyph.notice} </Text>
        <Text color={color.text}>usage </Text>
        <Text color={color.faint}>· spend &amp; limits (all sessions)</Text>
      </Box>

      {view.subscriptions.length ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={color.faint}>{"  subscriptions"}</Text>
          {view.subscriptions.map((a, i) => (
            <Box key={i}>
              <Text color={color.text}>{"    " + a.name.padEnd(labelPad)}</Text>
              <Text color={color.faint}>{"  " + a.turns + " turn" + (a.turns === 1 ? "" : "s")}</Text>
              {a.limits?.length ? (
                <Box flexDirection="column">
                  {a.limits.map((l) => (
                    <Text key={l.label}>
                      <Text color={color.faint}>{"    " + l.label + " "}</Text>
                      {typeof l.pct === "number" ? (
                        <>
                          <Bar frac={l.pct / 100} width={10} on={limitColor(l.pct)} />
                          <Text color={limitColor(l.pct)}>{" " + l.pct + "%"}</Text>
                        </>
                      ) : (
                        <Text color={l.status === "limited" ? color.err : l.status === "warn" ? color.warn : color.ok}>
                          {l.status === "limited" ? "limited" : l.status === "warn" ? "near limit" : "ok"}
                        </Text>
                      )}
                      {l.resetsIn ? <Text color={color.faint}>{" · " + l.resetsIn}</Text> : null}
                    </Text>
                  ))}
                </Box>
              ) : (
                <Text color={color.faint}>{"    " + (a.limitNote ?? "limits not observed yet")}</Text>
              )}
            </Box>
          ))}
        </Box>
      ) : null}

      {view.apiKeys.length ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={color.faint}>{"  api keys"}</Text>
          {view.apiKeys.map((a, i) => (
            <Box key={i}>
              <Text color={color.text}>{"    " + a.name.padEnd(labelPad)}</Text>
              <Text color={a.spendPos ? color.text : color.faint}>{"  " + (a.spend ?? "").padStart(spendPad)}</Text>
              <Text color={color.faint}>{"   " + a.turns + " turn" + (a.turns === 1 ? "" : "s") + " · " + a.tok}</Text>
              {a.balanceLeft ? <Text color={color.faint}>{" · " + a.balanceLeft}</Text> : null}
              {a.balanceNote ? <Text color={color.faint}>{" · " + a.balanceNote}</Text> : null}
            </Box>
          ))}
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text color={color.dim}>{"  total API spend "}</Text>
        <Text color={color.text}>{view.totalApiSpend}</Text>
        {view.sessionUSD ? <Text color={color.faint}>{"   ·   this session " + view.sessionUSD}</Text> : null}
      </Box>
      {view.hasEstimate ? <Text color={color.faint}>{"  ~ estimated (provider didn't report an exact cost)"}</Text> : null}
    </Box>
  );
}

const accountStateColor = (status: string) =>
  status === "active" || status === "signed in" || status === "ready" || status.startsWith("✓") ? color.ok :
  status === "not signed in" || status.startsWith("✗") ? color.err :
  status === "duplicate" || status.startsWith("⚠") || status.startsWith("⏳") ? color.warn :
  color.faint;

function AccountCard({ view }: { view: AccountView }) {
  const subs = view.rows.filter((r) => r.type === "subscription");
  const keys = view.rows.filter((r) => r.type === "API key");
  const commandWidth = Math.max(18, ...view.rows.map((r) => `/account ${r.alias}`.length));
  const Row = ({ r }: { r: AccountView["rows"][number] }) => {
    const cmd = `/account ${r.alias}`;
    return (
      <Box flexDirection="column">
        <Text>
          <Text color={r.active ? color.ok : color.faint}>{r.active ? "  ● " : "    "}</Text>
          <Text color={color.text} bold={r.active}>{r.name.padEnd(view.labelPad)}</Text>
          <Text color={accountStateColor(r.status)}>  {r.status.padEnd(view.statusPad)}</Text>
          <Text color={color.faint}>  use </Text>
          <Text color={color.accent} bold backgroundColor={color.accentBg}>{cmd.padEnd(commandWidth)}</Text>
        </Text>
        {r.duplicateOf ? (
          <Text color={color.faint}>{"      same login as "}<Text color={color.text}>{r.duplicateOf}</Text></Text>
        ) : r.detail ? (
          <Text color={color.faint}>{"      " + r.detail}</Text>
        ) : null}
      </Box>
    );
  };
  const Group = ({ title, rows }: { title: string; rows: AccountView["rows"] }) =>
    rows.length ? (
      <Box marginTop={1} flexDirection="column">
        <Text color={color.faint}>{"  " + title}</Text>
        {rows.map((r) => <Row key={r.alias} r={r} />)}
      </Box>
    ) : null;

  return (
    <Box flexDirection="column" marginTop={1} marginLeft={2}>
      <Box>
        <Text color={color.accentDim}>{glyph.notice} </Text>
        <Text color={color.text}>accounts</Text>
        <Text color={color.faint}> · current </Text>
        <Text color={color.text} bold>{view.current}</Text>
      </Box>
      <Group title="subscriptions" rows={subs} />
      <Group title="api keys" rows={keys} />
      {view.importable.length ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={color.faint}>{"  importable"}</Text>
          {view.importable.map((c) => (
            <Text key={`${c.provider}:${c.envVar}`}>
              <Text color={color.faint}>{"    "}</Text>
              <Text color={color.text}>{c.label}</Text>
              <Text color={color.faint}>{"  " + c.envVar + "  "}</Text>
              <Text color={color.accent}>/account import</Text>
            </Text>
          ))}
        </Box>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        <Text><Text color={color.faint}>{"  add     "}</Text><Text color={color.accent}>/account add codex [name]</Text><Text color={color.faint}>   </Text><Text color={color.accent}>/account add claude [name]</Text><Text color={color.faint}>   </Text><Text color={color.accent}>{"/account add <api-key>"}</Text></Text>
        <Text><Text color={color.faint}>{"  remove  "}</Text><Text color={color.accent}>{"/account remove <name>"}</Text></Text>
      </Box>
    </Box>
  );
}

const DIFF_MAX = 16;
const PREVIEW_LINES = 5;

function diffStats(lines?: { sign: "+" | "-"; text: string }[]): string {
  if (!lines?.length) return "";
  const add = lines.filter((l) => l.sign === "+").length;
  const del = lines.filter((l) => l.sign === "-").length;
  return `${add ? `+${add}` : "+0"} ${del ? `-${del}` : "-0"}`;
}

const codeLineRe =
  /^(\s{2,}\S|from\s+|import\s+|class\s+|def\s+|async\s+def\s+|@\w|if\s+|elif\s+|else:|for\s+|while\s+|try:|except\s+|finally:|with\s+|return\s+|[A-Za-z_][\w.]*\s*=|[A-Za-z_][\w.]*\(|"""|'''|\/\/|#include\b|const\s+|let\s+|var\s+|function\s+|type\s+|interface\s+|export\s+|package\s+|func\s+)/;

function looksLikeCode(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return false;
  const hits = lines.filter((l) => codeLineRe.test(l.trimStart() === l ? l.trim() : l)).length;
  if (lines.length === 2) return hits === 2;
  return hits / lines.length >= 0.55;
}

function guessLang(text: string): string {
  if (/^\s*(from|import|def|class|@dataclass)\b/m.test(text)) return "python";
  if (/^\s*(const|let|var|function|type|interface|export|import)\b/m.test(text)) return "ts";
  if (/^\s*(package|func)\b/m.test(text)) return "go";
  return "";
}

function CodeRows({ lines, lang, width, start = 1, rowBg }: { lines: string[]; lang?: string; width: number; start?: number; rowBg?: (line: string, i: number) => string }) {
  const lineNoWidth = Math.max(2, String(start + lines.length - 1).length);
  return (
    <>
      {lines.map((line, i) => {
        const bg = rowBg?.(line, i) ?? color.codeBg;
        const prefix = `${String(start + i).padStart(lineNoWidth)} │ `;
        const spans = highlightLine(line, lang);
        const used = prefix.length + spanLen(spans);
        return (
          <Text key={i}>
            <Text color={color.faint} backgroundColor={bg}>{prefix}</Text>
            {spans.map((s, j) => (
              <Text key={j} color={s.color} bold={s.bold} dimColor={s.dim} backgroundColor={bg}>{s.text}</Text>
            ))}
            <Text backgroundColor={bg}>{pad(used, width)}</Text>
          </Text>
        );
      })}
    </>
  );
}

function DiffView({ lines, width }: { lines: { sign: "+" | "-"; text: string }[]; width: number }) {
  const cap = lines.length > 24 ? 8 : DIFF_MAX; // big diffs collapse harder (matches lines.ts)
  const shown = lines.slice(0, cap);
  const extra = lines.length - shown.length;
  return (
    <Box flexDirection="column" marginLeft={5} marginTop={1}>
      {shown.map((l, i) => {
        const bg = l.sign === "+" ? color.diffAddBg : color.diffDelBg;
        const sign = l.sign === "+" ? "+ " : "− ";
        const spans = highlightLine(l.text);
        const used = sign.length + spanLen(spans);
        return (
          <Text key={i}>
            <Text color={l.sign === "+" ? color.ok : color.err} bold backgroundColor={bg}>{sign}</Text>
            {spans.map((s, j) => (
              <Text key={j} color={s.color} bold={s.bold} dimColor={s.dim} backgroundColor={bg}>{s.text}</Text>
            ))}
            <Text backgroundColor={bg}>{pad(used, width)}</Text>
          </Text>
        );
      })}
      {extra > 0 ? <Text color={color.faint}>… +{extra} more lines</Text> : null}
    </Box>
  );
}

const fmtMs = (ms?: number) => ms == null ? "" : ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
const toolColor = (item: Extract<Item, { kind: "tool" }>) =>
  item.name === "AskUserQuestion" ? color.accent :
  item.status === "err" ? color.err :
  item.status === "running" ? color.run :
  item.name === "run_shell" || item.name === "command_execution" ? color.accent :
  item.name.toLowerCase().includes("write") || item.name.toLowerCase().includes("edit") || item.name === "file_change" ? color.ok :
  color.accentDim;

function previewHighlight(line: string, lang: string | undefined, doc: { open: boolean }): { text: string; color?: string; bold?: boolean }[] {
  const isPy = /^(py|python)$/i.test(lang ?? "");
  const tripleCount = isPy ? (line.match(/("""|''')/g) ?? []).length : 0;
  if (isPy && (doc.open || tripleCount > 0)) {
    const spans = [{ text: line, color: color.codeString }];
    if (tripleCount % 2 === 1) doc.open = !doc.open;
    return spans;
  }
  return highlightLine(line, lang);
}

type TinySpan = { text: string; color?: string; bold?: boolean; bg?: string };

function noticeParts(text: string): TinySpan[] {
  const out: TinySpan[] = [];
  const re = /(\/account\s+\d+|\/[a-z][\w-]*(?:\s+[^\s]+)?|`[^`]+`|\b\d+\.\b|\b(?:Claude|ChatGPT|Anthropic|OpenAI|OpenRouter|subscription|API key|active|current|switch|add|remove|use)\b)/gi;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    const token = m[0]!;
    if (idx > last) out.push({ text: text.slice(last, idx), color: color.dim });
    const low = token.toLowerCase();
    const style =
      token.startsWith("/") ? { color: color.accent, bold: true, bg: color.accentBg } :
      token.startsWith("`") ? { color: color.path, bg: color.codeBg } :
      /^\d+\.$/.test(token) ? { color: color.accentDim, bold: true } :
      low === "subscription" || low === "api key" ? { color: color.ok, bold: true } :
      low === "active" || low === "current" ? { color: color.user, bold: true } :
      low === "switch" || low === "add" || low === "remove" || low === "use" ? { color: color.accentDim, bold: true } :
      { color: color.text, bold: true };
    out.push({ text: token, ...style });
    last = idx + token.length;
  }
  if (last < text.length) out.push({ text: text.slice(last), color: color.dim });
  return out.length ? out : [{ text, color: color.dim }];
}

function NoticeText({ text }: { text: string }) {
  // wrap explicitly: long single-line notices (the /model auto explanation)
  // must fold at the terminal edge instead of clipping — the inline path has
  // no lines.ts pre-wrap doing it for us.
  return (
    <Text wrap="wrap">
      {noticeParts(text).map((s, i) => (
        <Text key={i} color={s.color} bold={s.bold} backgroundColor={s.bg}>{s.text}</Text>
      ))}
    </Text>
  );
}

// Your turn: a full soft band, so old prompts remain readable in scrollback.
// Long lines are wrapped HERE (not by Ink) so every continuation row keeps the
// band's prefix + padding — Ink's default wrap would drop the background on
// the spill rows.
function UserLine({ text, width, turnNo }: { text: string; width: number; turnNo?: number }) {
  // Ledger heading for real turns; one quiet ❯ line for command echoes.
  if (turnNo == null) {
    return (
      <Box marginTop={1}>
        <Text color={color.faint}>{"  " + glyph.prompt + " "}</Text>
        <Text color={color.dim}>{text.split("\n")[0]}</Text>
      </Box>
    );
  }
  const idx = String(turnNo).padStart(2, "0");
  return (
    <Box marginTop={1} flexDirection="column">
      {turnNo > 1 ? <Text color={color.faint} dimColor>{glyph.rule.repeat(Math.max(8, width - 2))}</Text> : null}
      <Box marginTop={turnNo > 1 ? 1 : 0}>
        <Text color={color.user}>{idx + "  "}</Text>
        <Text color={color.text} bold>{text}</Text>
      </Box>
    </Box>
  );
}

// The reply: clean prose, indented, no marker · it reads as the open response.
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
const spanLen = (spans: { text: string }[]) => spans.reduce((n, s) => n + s.text.length, 0);
const pad = (used: number, width: number) => " ".repeat(Math.max(0, width - used));

function ToolLine({ item, width, expandAll = false }: { item: Extract<Item, { kind: "tool" }>; width: number; expandAll?: boolean }) {
  // Collapsed delegate_parallel group: one summary row that ⌃O expands to the
  // folded children. Mirrors the fullscreen lines.ts collapsed branch.
  if (item.collapsed) {
    return (
      <Box flexDirection="column" marginLeft={2} marginTop={1}>
        <Box>
          <Text color={item.status === "err" ? color.err : item.status === "running" ? toolColor(item) : color.faint}>{item.status === "running" ? glyph.off : glyph.corner}</Text>
          <Text color={color.dim} bold>{"  " + friendlyTool(item.name)}</Text>
          {item.summary ? <Text color={color.dim}>{"  ·  " + item.summary}</Text> : null}
          {item.durationMs != null ? <Text color={color.faint}>{"  ·  ~" + fmtMs(item.durationMs) + " total"}</Text> : null}
          {item.children?.length ? <Text color={color.faint}>{expandAll ? "  ⌃O collapses" : "  ⌃O expands"}</Text> : null}
        </Box>
        {expandAll && item.children?.length
          ? item.children.map((c, i) => <Row key={i} item={c} width={Math.max(width - 2, 8)} expandAll={expandAll} />)
          : null}
      </Box>
    );
  }
  const dotColor = toolColor(item);
  const out = item.outputTail ?? item.stream;
  const outLines = item.outputLines ?? item.streamCount ?? 0;
  const verb = friendlyTool(item.name).padEnd(6);
  const isShell = item.name === "run_shell" || item.name === "command_execution" || item.name === "Bash";
  const isWrite = !isShell && (item.name.toLowerCase().includes("write") || item.name.toLowerCase().includes("edit") || item.name === "file_change");
  const previewLines = item.preview?.split("\n") ?? [];
  const previewShown = expandAll ? previewLines : previewLines.slice(0, 8);
  const codeWidth = Math.max(30, width - 10);
  const docState = { open: false };
  return (
    <Box flexDirection="column" marginLeft={2} marginTop={1}>
      <Box>
        <Text color={item.status === "err" ? color.err : item.status === "running" ? dotColor : color.faint}>{item.status === "running" ? glyph.off : glyph.corner}</Text>
        <Text color={item.status === "err" ? color.err : color.dim} bold>{"  " + verb}</Text>
        {item.arg ? <Text color={isShell ? color.text : color.path} bold>{" " + (isShell ? item.arg : relPath(item.arg))}</Text> : null}
        {item.status === "running" && item.startedAt && Date.now() - item.startedAt >= 2000 ? <Text color={color.faint}>{"  " + fmtElapsed(Math.floor((Date.now() - item.startedAt) / 1000))}</Text> : null}
        {item.status !== "running" && item.durationMs != null ? <Text color={color.faint}>{"  " + fmtMs(item.durationMs)}</Text> : null}
        {item.exitCode != null ? <Text color={item.exitCode === 0 ? color.faint : color.err}>{"  exit " + item.exitCode}</Text> : null}
        {item.diff?.length ? (
          <Text>
            <Text color={color.ok}>{"  +" + item.diff.filter((l) => l.sign === "+").length}</Text>
            <Text color={color.err}>{" −" + item.diff.filter((l) => l.sign === "-").length}</Text>
          </Text>
        ) : null}
      </Box>
      {item.status === "running" && item.activity ? (
        <Box marginLeft={3}>
          <Text color={color.accentDim}>└─ </Text>
          <Text color={color.dim}>{item.activity}</Text>
        </Box>
      ) : item.status === "running" && !out && !item.stream ? (
        <Box marginLeft={3}>
          <Text color={color.accentDim}>└─ </Text>
          <Text color={color.faint}>{isWrite ? "drafting file · no code streamed yet" : isShell ? "waiting for output" : "no output yet"}</Text>
        </Box>
      ) : null}
      {item.preview ? (
        <Box marginLeft={3} marginTop={1} flexDirection="column">
          <Text>
            {(() => {
              const label = expandAll ? "full code" : "preview";
              const meta = expandAll ? ` · ${item.previewLines ?? previewLines.length} lines` : ` · ${previewShown.length} of ${item.previewLines ?? "?"} shown`;
              const used = 3 + label.length + meta.length;
              return <>
                <Text color={color.accentDim} backgroundColor={color.codeBg}>┌─ </Text>
                <Text color={color.accent} bold backgroundColor={color.codeBg}>{label}</Text>
                <Text color={color.faint} backgroundColor={color.codeBg}>{meta}</Text>
                <Text backgroundColor={color.codeBg}>{pad(used, codeWidth)}</Text>
              </>;
            })()}
          </Text>
          {previewShown.map((l, i) => {
            const spans = previewHighlight(l, item.previewLang, docState);
            const used = 2 + 3 + 2 + spanLen(spans);
            return (
              <Text key={i}>
                <Text color={color.accentDim} backgroundColor={color.codeBg}>│ </Text>
                <Text color={color.faint} backgroundColor={color.codeBg}>{String(i + 1).padStart(2)} </Text>
                <Text color={color.accentDim} backgroundColor={color.codeBg}>│ </Text>
                {spans.map((s, j) => (
                  <Text key={j} color={s.color} bold={s.bold} backgroundColor={color.codeBg}>{s.text}</Text>
                ))}
                <Text backgroundColor={color.codeBg}>{pad(used, codeWidth)}</Text>
              </Text>
            );
          })}
          {(item.previewLines ?? 0) > previewShown.length ? (
            <Text>
              <Text color={color.accentDim} backgroundColor={color.codeBg}>└─ </Text>
              <Text color={color.faint} backgroundColor={color.codeBg}>⌃O expands full code</Text>
              <Text backgroundColor={color.codeBg}>{pad(3 + "⌃O expands full code".length, codeWidth)}</Text>
            </Text>
          ) : expandAll ? (
            <Text>
              <Text color={color.accentDim} backgroundColor={color.codeBg}>└─ </Text>
              <Text color={color.faint} backgroundColor={color.codeBg}>⌃O collapses preview</Text>
              <Text backgroundColor={color.codeBg}>{pad(3 + "⌃O collapses preview".length, codeWidth)}</Text>
            </Text>
          ) : (
            <Text>
              <Text color={color.accentDim} backgroundColor={color.codeBg}>└─</Text>
              <Text backgroundColor={color.codeBg}>{pad(2, codeWidth)}</Text>
            </Text>
          )}
        </Box>
      ) : null}
      {out ? (
        <Box marginLeft={1} flexDirection="column">
          {(() => {
            const tail = expandAll ? 16 : PREVIEW_LINES;
            const shown = out.split("\n").filter((l) => l.length > 0).slice(-tail);
            if (isShell && looksLikeCode(shown.join("\n"))) {
              return (
                <Box marginTop={1} flexDirection="column">
                  {outLines > shown.length ? <Text color={color.faint}>{`… ${outLines} lines · ⌃O to expand`}</Text> : null}
                  <CodeRows lines={shown} lang={guessLang(shown.join("\n"))} width={Math.max(30, width - 12)} start={Math.max(1, outLines - shown.length + 1)} />
                </Box>
              );
            }
            return (
              <>
                {outLines > shown.length ? <Text color={color.faint}>{`… ${outLines} lines · ⌃O to expand`}</Text> : null}
                {shown.map((l, i) => (
                  <Text key={i} color={color.dim}>{`│ ${l}`}</Text>
                ))}
              </>
            );
          })()}
        </Box>
      ) : null}
      {item.status !== "running" && item.summary && item.summary !== item.name && item.summary.toLowerCase() !== friendlyTool(item.name) ? (
        <Box marginLeft={1}>
          <Text color={color.faint}>{glyph.result} </Text>
          <Box flexGrow={1}>
            <Text color={item.status === "err" ? color.err : color.dim}>{item.summary}</Text>
          </Box>
        </Box>
      ) : null}
      {item.diff && item.diff.length > 0 ? <DiffView lines={item.diff} width={Math.max(30, width - 12)} /> : null}
      {item.diagnostics?.length ? (
        <Box flexDirection="column">
          {item.diagnostics.slice(0, 4).map((d, i) => (
            <Box key={i}>
              <Text color={d.severity === "error" ? color.err : color.warn}>{glyph.notice} </Text>
              <Text color={d.severity === "error" ? color.err : color.warn} bold>{`${d.line}${d.col != null ? ":" + d.col : ""} `}</Text>
              <Text color={color.dim}>{d.message}</Text>
            </Box>
          ))}
          {item.diagnostics.length > 4 ? <Text color={color.faint}>{`… +${item.diagnostics.length - 4} more`}</Text> : null}
        </Box>
      ) : null}
    </Box>
  );
}

function SummaryLine({ item }: { item: Extract<Item, { kind: "summary" }> }) {
  const bits: string[] = [];
  if (item.changed.length) bits.push(`${item.changed.length} file${item.changed.length === 1 ? "" : "s"}`);
  if (item.checks.length) bits.push(`${item.checks.length} check${item.checks.length === 1 ? "" : "s"}`);
  if (item.failures.length) bits.push(`${item.failures.length} failed`);
  return (
    <Box flexDirection="column" marginTop={1} marginLeft={2}>
      <Box>
        <Text color={item.failures.length ? color.warn : color.ok}>{item.failures.length ? glyph.err + " " : glyph.check + " "}</Text>
        <Text color={color.text} bold>turn summary</Text>
        {bits.length ? <Text color={color.faint}>{" · " + bits.join(" · ")}</Text> : null}
      </Box>
      {item.changed.length ? <Text><Text color={color.faint}>{"  changed "}</Text><Text color={color.path}>{item.changed.slice(0, 4).join(", ") + (item.changed.length > 4 ? ` +${item.changed.length - 4}` : "")}</Text></Text> : null}
      {item.next ? <Text><Text color={color.dim}>{"  next "}</Text><Text color={color.accent}>{item.next}</Text></Text> : null}
    </Box>
  );
}

function PhaseLine({ item }: { item: Extract<Item, { kind: "phase" }> }) {
  const c = item.state === "err" ? color.err : item.state === "ok" ? color.ok : color.accentDim;
  return (
    <Box marginTop={1} marginLeft={2}>
      <Text color={c}>{item.state === "running" ? "◌ " : item.state === "ok" ? "✓ " : "▲ "}</Text>
      <Text color={item.state === "running" ? color.text : color.dim}>{item.label}</Text>
      {item.detail ? <Text color={color.faint}>{" · " + item.detail}</Text> : null}
    </Box>
  );
}

function ModelLine({ item }: { item: Extract<Item, { kind: "model" }> }) {
  // Post-turn provenance: routed → provider · model · cost. Dim when routine;
  // brightens to warn (amber) + a reason for a surprising routing decision.
  const head = item.surprising ? color.warn : color.faint;
  const body = item.surprising ? color.warn : color.dim;
  return (
    <Box marginTop={1} marginLeft={2}>
      <Text color={head}>↳ routed → </Text>
      <Text color={body}>{item.backendText ?? `${item.model} via ${item.provider}`}</Text>
      {item.costText ? <Text color={head}>{" · " + item.costText}</Text> : null}
      {item.surprising && item.reason ? <Text color={color.warn}>{" · " + item.reason}</Text> : null}
    </Box>
  );
}

function VerificationLine({ item }: { item: Extract<Item, { kind: "verification" }> }) {
  return (
    <Box marginTop={1} marginLeft={2}>
      <Text color={item.ok ? color.ok : color.err}>{item.ok ? "✓ " : "▲ "}</Text>
      <Text color={color.text}>check</Text>
      <Text color={color.faint}>{" · " + item.command + " · " + item.summary}</Text>
    </Box>
  );
}

function PreferenceLine({ item }: { item: Extract<Item, { kind: "preference" }> }) {
  // A mini consent line (mirrors lines.ts): ▸ question · the accept command as
  // an accent-on-accentBg chip — the command IS the action.
  return (
    <Box marginTop={1} marginLeft={2}>
      <Text color={color.accent}>▸ </Text>
      <Text color={color.text}>{item.text}</Text>
      <Text color={color.faint}>{" · "}</Text>
      <Text color={color.accent} bold backgroundColor={color.accentBg}>{item.acceptCommand}</Text>
    </Box>
  );
}

// The /context card: a bar per working-set section (sized to the largest) and a
// window-fill bar that greens→reds as the window fills.
function ContextCard({ view }: { view: ContextView }) {
  return (
    <Box flexDirection="column" marginTop={1} marginLeft={2}>
      <Box>
        <Text color={color.accentDim}>{glyph.notice} </Text>
        <Text color={color.text}>context · what's loaded for the next message</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {view.rows.map((r, i) => (
          <Box key={i}>
            <Text color={color.dim}>{"  " + r.label.padEnd(view.labelPad)}</Text>
            <Text color={color.text}>{"  " + r.display.padStart(view.valuePad) + "  "}</Text>
            <Bar frac={r.frac} width={18} on={color.accent} />
            {r.pct != null ? <Text color={color.faint}>{" " + r.pct + "% of window"}</Text> : null}
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={color.text}>{"  " + "total".padEnd(view.labelPad) + "  " + view.total.padStart(view.valuePad) + "  "}</Text>
        {view.windowPct != null ? (
          <Text>
            <Bar frac={view.windowPct / 100} width={18} on={limitColor(view.windowPct)} />
            <Text color={limitColor(view.windowPct)}>{" " + view.windowPct + "% of " + view.windowLabel}</Text>
          </Text>
        ) : null}
      </Box>
      {view.cwd ? <Text color={color.faint}>{"  working directory: " + view.cwd}</Text> : null}
    </Box>
  );
}

function ScorecardCard({ card, width }: { card: Scorecard; width: number }) {
  const toneColor: Record<string, string> = { title: color.text, colhead: color.faint, chosen: color.accent, row: color.dim, dim: color.faint, note: color.faint, summary: color.text };
  const rows = scorecardRows(card, Math.max(40, width - 4));
  return (
    <Box flexDirection="column" marginTop={1} marginLeft={2}>
      {rows.map((r, i) => (
        <Box key={i}>
          <Text color={color.accentDim}>{i === 0 ? glyph.notice + " " : "  "}</Text>
          <Text color={toneColor[r.tone] ?? color.text}>{r.text}</Text>
        </Box>
      ))}
    </Box>
  );
}

// One transcript item → its element (no key; the caller supplies it).
function Row({ item, width, expandAll = false }: { item: Item; width: number; expandAll?: boolean }) {
  switch (item.kind) {
    case "user":
      return <UserLine text={item.text} width={width} turnNo={item.turnNo} />;
    case "assistant":
      return <AssistantLine text={item.text} width={width} />;
    case "tool":
      return <ToolLine item={item} width={width} expandAll={expandAll} />;
    case "phase":
      return <PhaseLine item={item} />;
    case "model":
      return <ModelLine item={item} />;
    case "verification":
      return <VerificationLine item={item} />;
    case "preference":
      return <PreferenceLine item={item} />;
    case "summary":
      return <SummaryLine item={item} />;
    case "accounts":
      return <AccountCard view={item.view} />;
    case "usage":
      return <UsageCard view={item.view} />;
    case "context":
      return <ContextCard view={item.view} />;
    case "scorecard":
      return <ScorecardCard card={item.card} width={width} />;
    case "notice":
      return (
        <Box marginTop={1} marginLeft={2} flexDirection="column">
          {item.text.split("\n").map((line, i) => (
            <Box key={i}>
              <Text color={color.accentDim}>{i === 0 ? glyph.notice + " " : "  "}</Text>
              <NoticeText text={line} />
            </Box>
          ))}
        </Box>
      );
    case "error":
      // One error lane: a single red left bar down the whole message, shown once.
      return (
        <Box marginTop={1} flexDirection="column">
          {item.text.split("\n").map((line, i) => (
            <Box key={i}>
              <Text color={color.err}>{glyph.quote} </Text>
              <Box flexGrow={1}>
                <Text color={color.err}>{line}</Text>
              </Box>
            </Box>
          ))}
        </Box>
      );
  }
}

// An item is "final" once it will never change again · so it's safe to commit to
// native scrollback. The streaming assistant reply and a running tool are not.
function isFinal(it: Item): boolean {
  if (it.kind === "assistant") return !!it.done;
  if (it.kind === "tool") return it.status !== "running";
  if (it.kind === "phase") return it.state !== "running";
  return true;
}

/**
 * Inline renderer. Finished items are written ONCE via Ink's <Static> (they flow
 * into the terminal's native scrollback and are never re-rendered), so long,
 * streaming sessions don't flicker or corrupt the way a fully-dynamic tree does.
 * Only the live tail (from the first not-yet-final item onward) re-renders. An
 * optional `header` (the banner) is committed as the first static entry so it
 * sits above the history, with the input pinned below by the caller.
 */
export function Transcript({ items, width = 80, header, expandAll = false }: { items: Item[]; width?: number; header?: React.ReactNode; expandAll?: boolean }) {
  if (expandAll) {
    return (
      <Box flexDirection="column" paddingX={1}>
        {header}
        {items.map((it) => (
          <Row key={it.id} item={it} width={width} expandAll />
        ))}
      </Box>
    );
  }

  let cut = items.length;
  for (let i = 0; i < items.length; i++) {
    if (!isFinal(items[i]!)) {
      cut = i;
      break;
    }
  }
  const committed = items.slice(0, cut);
  const live = items.slice(cut);

  type Entry = { key: string; kind: "header" } | { key: string; kind: "item"; item: Item };
  const entries: Entry[] = [];
  if (header) entries.push({ key: "header", kind: "header" });
  for (const it of committed) entries.push({ key: String(it.id), kind: "item", item: it });

  return (
    <>
      <Static items={entries}>
        {(e) => (
          <Box key={e.key} paddingX={e.kind === "item" ? 1 : 0}>
            {e.kind === "header" ? header : <Row item={e.item} width={width} expandAll={expandAll} />}
          </Box>
        )}
      </Static>
      {live.length ? (
        <Box flexDirection="column" paddingX={1}>
          {live.map((it) => (
            <Row key={it.id} item={it} width={width} expandAll={expandAll} />
          ))}
        </Box>
      ) : null}
    </>
  );
}
