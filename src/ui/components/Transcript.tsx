import React from "react";
import { Box, Text, Static } from "ink";
import { color, glyph } from "../theme.ts";
import type { Item } from "../types.ts";
import { Markdown } from "./Markdown.tsx";
import { barCells, type UsageView } from "../../accounts/usage.ts";
import type { ContextView } from "../types.ts";

// Limit-utilization color: green when there's headroom, accent mid, coral when
// you're nearly maxed (≥85%) so it reads as a warning.
const limitColor = (pct: number) => (pct >= 85 ? color.err : pct >= 60 ? color.accent : color.ok);

function Bar({ frac, width, on }: { frac: number; width: number; on: string }) {
  const { fill, empty } = barCells(frac, width);
  return (
    <Text>
      <Text color={on}>{fill}</Text>
      <Text color={color.faint}>{empty}</Text>
    </Text>
  );
}

// The /usage card: a spend bar per account (accent), a green→coral limit bar
// where the provider reports one. Same data as the fullscreen path (lines.ts).
function UsageCard({ view }: { view: UsageView }) {
  return (
    <Box flexDirection="column" marginTop={1} marginLeft={2}>
      <Box>
        <Text color={color.accentDim}>{glyph.notice} </Text>
        <Text color={color.text}>cost · spend per account </Text>
        <Text color={color.faint}>(all sessions)</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {view.rows.map((r, i) => {
          const zero = r.spend.trim().startsWith("$0.00");
          return (
            <Box key={i}>
              <Text color={color.text}>{"  " + r.name}</Text>
              <Text color={zero ? color.faint : color.ok}>{"  " + r.spend + "  "}</Text>
              <Bar frac={r.spendFrac} width={view.barWidth} on={color.accent} />
              <Text color={color.faint}>{"  " + r.meta}</Text>
              {r.limitPct != null ? (
                <Text>
                  <Text color={color.faint}>{"   " + (r.limitLabel ?? "") + " "}</Text>
                  <Bar frac={r.limitPct / 100} width={6} on={limitColor(r.limitPct)} />
                  <Text color={limitColor(r.limitPct)}>{" " + r.limitPct + "%"}</Text>
                </Text>
              ) : null}
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={color.dim}>{"  total  "}</Text>
        <Text color={color.text}>{view.total.trim()}</Text>
        {view.sessionUSD ? <Text color={color.faint}>{"     this session (est): " + view.sessionUSD}</Text> : null}
      </Box>
      {view.hasEstimate ? <Text color={color.faint}>{"  ~ estimated (provider didn't report an exact cost)"}</Text> : null}
    </Box>
  );
}

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

// One transcript item → its element (no key; the caller supplies it).
function Row({ item, width }: { item: Item; width: number }) {
  switch (item.kind) {
    case "user":
      return <UserLine text={item.text} />;
    case "assistant":
      return <AssistantLine text={item.text} width={width} />;
    case "tool":
      return <ToolLine item={item} />;
    case "usage":
      return <UsageCard view={item.view} />;
    case "context":
      return <ContextCard view={item.view} />;
    case "notice":
      return (
        <Box marginTop={1} marginLeft={2}>
          <Text color={color.accentDim}>{glyph.notice} </Text>
          <Box flexGrow={1}>
            <Text color={color.dim}>{item.text}</Text>
          </Box>
        </Box>
      );
    case "error":
      return (
        <Box marginTop={1} marginLeft={2}>
          <Text color={color.err}>{glyph.err} </Text>
          <Box flexGrow={1}>
            <Text color={color.err}>{item.text}</Text>
          </Box>
        </Box>
      );
  }
}

// An item is "final" once it will never change again — so it's safe to commit to
// native scrollback. The streaming assistant reply and a running tool are not.
function isFinal(it: Item): boolean {
  if (it.kind === "assistant") return !!it.done;
  if (it.kind === "tool") return it.status !== "running";
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
export function Transcript({ items, width = 80, header }: { items: Item[]; width?: number; header?: React.ReactNode }) {
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
            {e.kind === "header" ? header : <Row item={e.item} width={width} />}
          </Box>
        )}
      </Static>
      {live.length ? (
        <Box flexDirection="column" paddingX={1}>
          {live.map((it) => (
            <Row key={it.id} item={it} width={width} />
          ))}
        </Box>
      ) : null}
    </>
  );
}
