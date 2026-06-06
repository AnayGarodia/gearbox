import React from "react";
import { Box, Text } from "ink";
import { color, glyph } from "../theme.ts";
import { Viewport } from "./Viewport.tsx";
import { itemsToLines, type Line } from "../lines.ts";
import { panelBodyHeight, windowStart, filterModelRows, clampIndex, type PanelState, type PanelModelRow } from "../panel.ts";
import type { AccountView } from "../types.ts";

function accountStateColor(status: string): string {
  if (status === "active") return color.ok;
  if (/not signed in/i.test(status)) return color.err;
  return color.faint;
}

// A full-region, Esc-dismissable overlay that replaces the transcript while open.
// Three flavours: a scrollable static dump (reuses the line buffer + Viewport), or
// an interactive accounts / models list (↑↓ select, ⏎ acts — handled in App).
export function Panel({
  panel,
  width,
  height,
  accounts,
  models,
  currentModelId,
  staticLines,
}: {
  panel: PanelState;
  width: number;
  height: number;
  accounts?: AccountView;
  models?: PanelModelRow[];
  currentModelId?: string | null;
  staticLines?: Line[]; // precomputed by App so it and the key-handler agree on length
}) {
  const bodyH = panelBodyHeight(height);
  const innerW = Math.max(4, width - 2);

  let body: React.ReactNode = null;
  let hint = "esc close";

  if (panel.kind === "static") {
    const lines = staticLines ?? itemsToLines(panel.items, innerW);
    const maxScroll = Math.max(0, lines.length - bodyH);
    const scroll = Math.min(panel.scroll, maxScroll);
    body = (
      <Box paddingX={1}>
        <Viewport lines={lines} scrollTop={scroll} height={bodyH} width={innerW} />
      </Box>
    );
    hint = lines.length > bodyH ? "↑↓ / PgUp PgDn scroll · esc close" : "esc close";
  } else if (panel.kind === "accounts") {
    const rows = accounts?.rows ?? [];
    const idx = clampIndex(panel.index, rows.length);
    const start = windowStart(idx, rows.length, bodyH);
    const slice = rows.slice(start, start + bodyH);
    const labelPad = accounts?.labelPad ?? 0;
    body = (
      <Box flexDirection="column" paddingX={1}>
        {rows.length === 0 ? (
          <Text color={color.faint}>no accounts yet — /account add to add one</Text>
        ) : (
          slice.map((r, i) => {
            const sel = start + i === idx;
            return (
              <Text key={r.alias} backgroundColor={sel ? color.accentBg : undefined}>
                <Text color={sel ? color.accent : color.faint}>{sel ? "▶ " : "  "}</Text>
                <Text color={color.text} bold={r.active}>{r.name.padEnd(labelPad)}</Text>
                <Text color={color.faint}>  {r.type}</Text>
                <Text color={accountStateColor(r.status)}>  {r.status}</Text>
                {r.detail ? <Text color={color.faint}>  · {r.detail}</Text> : null}
                {r.type === "subscription" && !(r.detail && r.detail.includes("@")) ? (
                  <Text color={color.accentDim}>  · /account login {r.alias} to identify</Text>
                ) : null}
                {r.active ? <Text color={color.ok}>  {glyph.on} current</Text> : null}
              </Text>
            );
          })
        )}
      </Box>
    );
    hint = "↑↓ move · ⏎ switch · esc close";
  } else {
    const rows = filterModelRows(models ?? [], panel.filter);
    const idx = clampIndex(panel.index, rows.length);
    const start = windowStart(idx, rows.length, bodyH);
    const slice = rows.slice(start, start + bodyH);
    body = (
      <Box flexDirection="column" paddingX={1}>
        {rows.length === 0 ? (
          <Text color={color.faint}>no models match “{panel.filter}”</Text>
        ) : (
          slice.map((r, i) => {
            const sel = start + i === idx;
            const pinned = r.id === currentModelId;
            return (
              <Text key={r.id} backgroundColor={sel ? color.accentBg : undefined}>
                <Text color={sel ? color.accent : color.faint}>{sel ? "▶ " : "  "}</Text>
                <Text color={pinned ? color.ok : color.text} bold={pinned}>{r.label.padEnd(22)}</Text>
                <Text color={color.faint}>{r.provider}</Text>
                {pinned ? <Text color={color.ok}>  {glyph.on} pinned</Text> : null}
              </Text>
            );
          })
        )}
      </Box>
    );
    hint = `filter: ${panel.filter || "(type to filter)"}  ·  ↑↓ · ⏎ pin · esc close`;
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box width={width} paddingX={1} justifyContent="space-between">
        <Text color={color.accent} bold>{panel.title}</Text>
        <Text color={color.faint}>esc to close</Text>
      </Box>
      <Box flexDirection="column" width={width} height={bodyH}>{body}</Box>
      <Box width={width} paddingX={1}>
        <Text color={color.faint}>{hint}</Text>
      </Box>
    </Box>
  );
}
