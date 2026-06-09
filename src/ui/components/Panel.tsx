import React from "react";
import { Box, Text } from "ink";
import { color, glyph } from "../theme.ts";
import { Viewport } from "./Viewport.tsx";
import { itemsToLines, type Line } from "../lines.ts";
import { panelBodyHeight, windowStart, filterModelRows, clampIndex, type PanelState, type PanelModelRow, type PanelSessionRow } from "../panel.ts";
import { filterAddSpecs, type AddSpec } from "../../accounts/add-spec.ts";
import type { AccountView } from "../types.ts";

function accountStateColor(status: string): string {
  if (status === "active") return color.ok;
  if (/not signed in/i.test(status)) return color.err;
  return color.faint;
}

// A full-region, Esc-dismissable overlay that replaces the transcript while open.
// Three flavours: a scrollable static dump (reuses the line buffer + Viewport), or
// an interactive accounts / models list (↑↓ select, ⏎ acts · handled in App).
export function Panel({
  panel,
  width,
  height,
  accounts,
  models,
  sessions,
  currentModelId,
  staticLines,
  wizardSpec,
}: {
  panel: PanelState;
  width: number;
  height: number;
  accounts?: AccountView;
  models?: PanelModelRow[];
  sessions?: PanelSessionRow[];
  currentModelId?: string | null;
  staticLines?: Line[]; // precomputed by App so it and the key-handler agree on length
  wizardSpec?: AddSpec; // resolved by App for the wizard's field phase
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
    const labelPad = accounts?.labelPad ?? 0;
    // A pinned "+ Add an account" row sits at logical index 0; account rows follow.
    // App's key/mouse handlers move panel.index over (rows.length + 1) and map index 0
    // to the "__add__" slug (opens the wizard). Window over the combined list.
    type AcctRow = (typeof rows)[number];
    const items: ({ add: true } | { add: false; r: AcctRow })[] = [{ add: true }, ...rows.map((r) => ({ add: false as const, r }))];
    const idx = clampIndex(panel.index, items.length);
    const start = windowStart(idx, items.length, bodyH);
    const slice = items.slice(start, start + bodyH);
    body = (
      <Box flexDirection="column" paddingX={1}>
        {slice.map((row, i) => {
          const sel = start + i === idx;
          if (row.add) {
            return (
              <Text key="__add__" backgroundColor={sel ? color.accentBg : undefined}>
                <Text color={sel ? color.accent : color.faint}>{sel ? "▶ " : "  "}</Text>
                <Text color={color.accent} bold={sel}>+ Add an account</Text>
                <Text color={color.faint}>  any provider · subscription · key</Text>
              </Text>
            );
          }
          const r = row.r;
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
        })}
      </Box>
    );
    hint = "↑↓ move · ⏎ select · esc close";
  } else if (panel.kind === "sessions") {
    const rows = sessions ?? [];
    const idx = clampIndex(panel.index, rows.length);
    const start = windowStart(idx, rows.length, bodyH);
    const slice = rows.slice(start, start + bodyH);
    body = (
      <Box flexDirection="column" paddingX={1}>
        {rows.length === 0 ? (
          <Text color={color.faint}>no other saved sessions for this project yet</Text>
        ) : (
          slice.map((r, i) => {
            const sel = start + i === idx;
            return (
              <Text key={r.id} backgroundColor={sel ? color.accentBg : undefined}>
                <Text color={sel ? color.accent : color.faint}>{sel ? "▶ " : "  "}</Text>
                <Text color={color.text} bold={sel}>{(r.title || "(untitled)").slice(0, 52)}</Text>
                <Text color={color.faint}>  · {r.turns} turn{r.turns === 1 ? "" : "s"} · {r.when}</Text>
              </Text>
            );
          })
        )}
      </Box>
    );
    hint = "↑↓ move · ⏎ load · esc close";
  } else if (panel.kind === "wizard" && panel.wizardPhase.phase === "pick") {
    const ph = panel.wizardPhase;
    const specs = filterAddSpecs(ph.filter);
    const idx = clampIndex(ph.index, specs.length);
    const start = windowStart(idx, specs.length, bodyH);
    const slice = specs.slice(start, start + bodyH);
    body = (
      <Box flexDirection="column" paddingX={1}>
        {specs.length === 0 ? (
          <Text color={color.faint}>no provider matches “{ph.filter}”</Text>
        ) : (
          slice.map((s, i) => {
            const sel = start + i === idx;
            return (
              <Text key={s.id} backgroundColor={sel ? color.accentBg : undefined}>
                <Text color={sel ? color.accent : color.faint}>{sel ? "▶ " : "  "}</Text>
                <Text color={color.text} bold={sel}>{s.label.padEnd(24)}</Text>
                <Text color={color.faint}>  {s.summary}</Text>
              </Text>
            );
          })
        )}
      </Box>
    );
    hint = `${ph.filter ? `filter: ${ph.filter}  ·  ` : ""}↑↓ · ⏎ select · esc close`;
  } else if (panel.kind === "wizard" && panel.wizardPhase.phase === "field") {
    const ph = panel.wizardPhase;
    const spec = wizardSpec;
    const field = spec?.fields[ph.fieldIndex];
    const total = spec?.fields.length ?? 0;
    const filledEntries = Object.entries(ph.filled);
    body = (
      <Box flexDirection="column" paddingX={1}>
        <Text color={color.faint}>{spec?.label ?? ""} · step {Math.min(ph.fieldIndex + 1, total)} of {total}</Text>
        {filledEntries.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            {filledEntries.map(([k, v]) => {
              const f = spec?.fields.find((x) => x.key === k);
              const shown = f?.secret ? "••••••••" : !v.trim() ? "(skipped)" : v.length > 40 ? v.slice(0, 39) + "…" : v;
              return (
                <Text key={k} color={color.faint}>
                  <Text color={color.ok}>{glyph.on} </Text>
                  {(f?.label ?? k).replace(/ \(optional.*\)$/, "")}: <Text color={color.dim}>{shown}</Text>
                </Text>
              );
            })}
          </Box>
        ) : null}
        <Box marginTop={1} flexDirection="column">
          <Text>
            <Text color={color.accent} bold>{field?.label ?? ""}</Text>
            {field?.secret ? <Text color={color.faint}>  (visible as typed)</Text> : null}
          </Text>
          <Box>
            <Text color={color.faint}>{glyph.prompt} </Text>
            <Text color={color.text}>{ph.fieldEdit.value}</Text>
            <Text color={color.accent} inverse> </Text>
          </Box>
          {!ph.fieldEdit.value && field ? <Text color={color.faint}>  e.g. {field.placeholder}</Text> : null}
          {ph.fieldError ? <Text color={color.err}>  {glyph.err} {ph.fieldError}</Text> : null}
        </Box>
      </Box>
    );
    hint = "⏎ confirm · esc back";
  } else if (panel.kind === "models") {
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
