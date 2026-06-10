import React from "react";
import { Box, Text } from "ink";
import { color, glyph, THEMES } from "../theme.ts";
import { Viewport } from "./Viewport.tsx";
import { ShimmerText } from "./Shimmer.tsx";
import { itemsToLines, type Line } from "../lines.ts";
import { panelBodyHeight, windowStart, filterModelRows, clampIndex, truncate, fieldWindow, type PanelState, type PanelModelRow, type PanelSessionRow, type AccountDetailViewData } from "../panel.ts";
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
  accountDetail,
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
  accountDetail?: AccountDetailViewData; // resolved by App for the account-detail panel
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
    // A pinned "+ add an account" row sits at logical index 0; account rows follow.
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
              <Text key="__add__" wrap="truncate-end" backgroundColor={sel ? color.accentBg : undefined}>
                <Text color={sel ? color.accent : color.faint}>{sel ? `${glyph.select} ` : "  "}</Text>
                <Text color={color.accent} bold={sel}>+ add an account</Text>
                <Text color={color.faint}>  any provider · subscription · key</Text>
              </Text>
            );
          }
          const r = row.r;
          return (
            <Text key={r.alias} wrap="truncate-end" backgroundColor={sel ? color.accentBg : undefined}>
              <Text color={sel ? color.accent : color.faint}>{sel ? `${glyph.select} ` : "  "}</Text>
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
    hint = "↑↓ move · ⏎ select · → detail · esc close";
  } else if (panel.kind === "sessions") {
    const rows = sessions ?? [];
    const idx = clampIndex(panel.index, rows.length);
    const listH = Math.max(1, bodyH - 4); // reserve rows for the preview pane
    const start = windowStart(idx, rows.length, listH);
    const slice = rows.slice(start, start + listH);
    const cur = rows[idx];
    body = (
      <Box flexDirection="column" paddingX={1}>
        {rows.length === 0 ? (
          <Text color={color.faint}>no other saved sessions for this project yet</Text>
        ) : (
          slice.map((r, i) => {
            const sel = start + i === idx;
            const renaming = panel.rename?.id === r.id;
            const armed = panel.confirmDelete === r.id;
            if (renaming && panel.rename) {
              const fw = fieldWindow(panel.rename.fieldEdit.value, panel.rename.fieldEdit.cursor, Math.max(8, innerW - 10));
              return (
                <Text key={r.id} wrap="truncate-end" backgroundColor={color.accentBg}>
                  <Text color={color.accent}>{glyph.select} </Text>
                  <Text color={color.faint}>rename: </Text>
                  <Text color={color.text}>{fw.pre}</Text>
                  <Text color={color.accent} inverse>{fw.at}</Text>
                  <Text color={color.text}>{fw.post}</Text>
                </Text>
              );
            }
            return (
              <Text key={r.id} wrap="truncate-end" backgroundColor={sel ? color.accentBg : undefined}>
                <Text color={sel ? color.accent : color.faint}>{sel ? `${glyph.select} ` : "  "}</Text>
                {r.pinned ? <Text color={color.warn}>{glyph.on} </Text> : null}
                <Text color={armed ? color.err : color.text} bold={sel}>{truncate(r.title || "(untitled)", 52)}</Text>
                <Text color={armed ? color.err : color.faint}>{armed ? "  · press d again to delete" : `  · ${r.turns} turn${r.turns === 1 ? "" : "s"} · ${r.when}`}</Text>
              </Text>
            );
          })
        )}
        {cur?.preview && (cur.preview.ask || cur.preview.reply) ? (
          <Box flexDirection="column" marginTop={1}>
            <Text wrap="truncate-end" color={color.faint}>{glyph.quote} <Text color={color.user}>{truncate(cur.preview.ask, Math.max(8, innerW - 4))}</Text></Text>
            {cur.preview.reply ? <Text wrap="truncate-end" color={color.faint}>{glyph.quote} {truncate(cur.preview.reply, Math.max(8, innerW - 4))}</Text> : null}
          </Box>
        ) : null}
      </Box>
    );
    hint = panel.rename ? "⏎ save name · esc cancel" : "↑↓ move · ⏎ load · p pin · r rename · d delete · esc close";
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
              <Text key={s.id} wrap="truncate-end" backgroundColor={sel ? color.accentBg : undefined}>
                <Text color={sel ? color.accent : color.faint}>{sel ? `${glyph.select} ` : "  "}</Text>
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
              const shown = f?.secret ? "••••••••" : !v.trim() ? "(skipped)" : truncate(v, 40);
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
          {(() => {
            const fw = fieldWindow(ph.fieldEdit.value, ph.fieldEdit.cursor, Math.max(8, innerW - 4));
            return (
              <Box>
                <Text color={color.faint}>{glyph.prompt} </Text>
                <Text color={color.text}>{fw.pre}</Text>
                <Text color={color.accent} inverse>{fw.at}</Text>
                <Text color={color.text}>{fw.post}</Text>
              </Box>
            );
          })()}
          {!ph.fieldEdit.value && field ? <Text color={color.faint}>  e.g. {field.placeholder}</Text> : null}
          {ph.fieldError ? <Text color={color.err}>  {glyph.err} {ph.fieldError}</Text> : null}
          {field?.hint ? (
            <Box flexDirection="column" marginTop={1}>
              {field.hint.split("\n").map((line, i) => (
                <Text key={i} color={color.faint}>  {line}</Text>
              ))}
            </Box>
          ) : null}
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
              <Text key={r.id} wrap="truncate-end" backgroundColor={sel ? color.accentBg : undefined}>
                <Text color={sel ? color.accent : color.faint}>{sel ? `${glyph.select} ` : "  "}</Text>
                <Text color={pinned ? color.ok : color.text} bold={pinned}>{truncate(r.label, 28).padEnd(28)}</Text>
                <Text color={color.faint}>{r.provider}</Text>
                {pinned ? <Text color={color.ok}>  {glyph.on} pinned</Text> : null}
              </Text>
            );
          })
        )}
      </Box>
    );
    hint = `filter: ${panel.filter || "(type to filter)"}  ·  ↑↓ · ⏎ pin · esc close`;
  } else if (panel.kind === "themes") {
    const idx = clampIndex(panel.index, THEMES.length);
    body = (
      <Box flexDirection="column" paddingX={1}>
        {THEMES.map((t, i) => {
          const sel = i === idx;
          const active = t.name === panel.original;
          return (
            <Text key={t.name} wrap="truncate-end" backgroundColor={sel ? color.accentBg : undefined}>
              <Text color={sel ? color.accent : color.faint}>{sel ? `${glyph.select} ` : "  "}</Text>
              <Text color={color.text} bold={sel}>{t.label.padEnd(20)}</Text>
              {/* A swatch of the palette's own semantics — readable in ANY theme. */}
              <Text color={t.palette.accent}>{glyph.on}</Text>
              <Text color={t.palette.ok}>{glyph.on}</Text>
              <Text color={t.palette.warn}>{glyph.on}</Text>
              <Text color={t.palette.err}>{glyph.on}</Text>
              <Text color={t.palette.path}>{glyph.on}</Text>
              <Text color={color.faint}>  {t.hint}</Text>
              {active ? <Text color={color.ok}>  {glyph.check} current</Text> : null}
            </Text>
          );
        })}
        <Box marginTop={1}><Text color={color.faint}>the whole screen previews as you move</Text></Box>
      </Box>
    );
    hint = "↑↓ preview live · ⏎ keep · esc revert";
  } else if (panel.kind === "git-confirm") {
    const fw = fieldWindow(panel.subject.value, panel.subject.cursor, Math.max(8, innerW - 4));
    // Budget with the RENDERED file rows (≤6 + "+N more"), not the raw staged
    // count — 30 staged files must not squeeze the generated body to one line.
    const fileRows = Math.min(6, panel.files.length) + (panel.files.length > 6 ? 1 : 0);
    const bodyLines = panel.body ? panel.body.split("\n").slice(0, Math.max(1, bodyH - fileRows - 7)) : [];
    body = (
      <Box flexDirection="column" paddingX={1}>
        <Text color={color.accent} bold>{panel.mode === "commit" ? "commit message" : "PR title"}</Text>
        <Box>
          <Text color={color.faint}>{glyph.prompt} </Text>
          <Text color={color.text}>{fw.pre}</Text>
          <Text color={color.accent} inverse>{fw.at}</Text>
          <Text color={color.text}>{fw.post}</Text>
        </Box>
        {bodyLines.length ? (
          <Box flexDirection="column" marginTop={1}>
            {bodyLines.map((l, i) => (
              <Text key={i} color={color.dim}>{truncate(l, Math.max(8, innerW - 2))}</Text>
            ))}
          </Box>
        ) : null}
        <Box flexDirection="column" marginTop={1}>
          {panel.stat ? <Text color={color.faint}>{truncate(panel.stat, Math.max(8, innerW - 2))}</Text> : null}
          {panel.files.slice(0, Math.max(1, Math.min(6, panel.files.length))).map((f) => (
            <Text key={f} color={color.path}>  {truncate(f, Math.max(8, innerW - 4))}</Text>
          ))}
          {panel.files.length > 6 ? <Text color={color.faint}>  +{panel.files.length - 6} more</Text> : null}
        </Box>
        {panel.error ? <Box marginTop={1}><Text color={color.err}>{glyph.err} {truncate(panel.error, Math.max(8, innerW - 4))}</Text></Box> : null}
        {panel.submitting ? <Box marginTop={1}><Text color={color.faint}>{panel.mode === "commit" ? "committing…" : "creating the PR…"}</Text></Box> : null}
      </Box>
    );
    hint = panel.mode === "commit" ? "⏎ commit · ⌃R regenerate · esc cancel" : "⏎ create PR · ⌃R regenerate · esc cancel";
  } else if (panel.kind === "account-detail") {
    const ph = panel.detailPhase;
    if (ph.phase === "browse") {
      const deps = panel.deployments ?? [];
      const listH = Math.max(1, bodyH - 1); // reserve 1 row for meta header
      const idx = clampIndex(panel.index, deps.length);
      const start = windowStart(idx, deps.length, listH);
      const slice = deps.slice(start, start + listH);
      // Width-aware columns: the id column flexes with the terminal so a row
      // can't wrap (a wrapped row breaks the 1-row-per-item window math).
      const idW = Math.min(40, Math.max(20, innerW - 38));
      body = (
        <Box flexDirection="column" paddingX={1}>
          <Text color={color.faint} wrap="truncate-end">
            {panel.loadError
              ? <Text color={color.err}>{glyph.err} {truncate(panel.loadError, Math.max(8, innerW - 4))}</Text>
              : panel.deployments === null
              ? <ShimmerText text="loading deployments…" />
              : panel.refreshing
              ? <Text>{deps.length} deployment{deps.length !== 1 ? "s" : ""} · refreshing…</Text>
              : <Text>{deps.length} deployment{deps.length !== 1 ? "s" : ""}</Text>}
            {accountDetail?.endpoint && !panel.loadError ? <Text>  · {truncate(accountDetail.endpoint, Math.max(8, innerW - 24))}</Text> : null}
            {panel.submitting ? <Text>  · working…</Text> : null}
          </Text>
          {deps.length === 0 && !panel.loadError && panel.deployments !== null ? (
            <Text color={color.faint}>
              {panel.modelsError
                ? `  no deployments yet · couldn't load deployable models — r to retry`
                : panel.availableModels === null
                ? `  no deployments yet · loading deployable models…`
                : `  no deployments yet · press d to deploy a model`}
            </Text>
          ) : (
            slice.map((d, i) => {
              const sel = start + i === idx;
              const failed = d.status === "failed";
              return (
                <Text key={d.id} wrap="truncate-end" backgroundColor={sel ? color.accentBg : undefined}>
                  <Text color={sel ? color.accent : color.faint}>{sel ? `${glyph.select} ` : "  "}</Text>
                  <Text color={failed ? color.err : color.text} bold={sel}>{truncate(d.id, idW).padEnd(idW)}</Text>
                  <Text color={color.faint}>  {truncate(d.model, 22)}</Text>
                  <Text color={failed ? color.err : d.status === "succeeded" ? color.ok : color.warn}>  {d.status}</Text>
                  {d.capacityUnits !== undefined ? <Text color={color.faint}>  {d.capacityUnits}PTU</Text> : null}
                </Text>
              );
            })
          )}
          {panel.armReady === false ? (
            <Text color={color.warn} wrap="truncate-end">
              ⚠ deploy/delete needs an Azure sign-in — /account login {accountDetail?.id ?? "<account>"}
            </Text>
          ) : null}
        </Box>
      );
      hint = `↑↓ move · d deploy · ⌫ delete · r refresh · esc close`;
    } else if (ph.phase === "deploy-pick") {
      const models = panel.availableModels ?? [];
      const q = ph.filter.trim().toLowerCase();
      const filtered = q ? models.filter((m) => m.toLowerCase().includes(q)) : models;
      const idx = clampIndex(ph.index, filtered.length);
      const start = windowStart(idx, filtered.length, bodyH);
      const slice = filtered.slice(start, start + bodyH);
      body = (
        <Box flexDirection="column" paddingX={1}>
          {filtered.length === 0 ? (
            panel.availableModels === null
              ? (panel.modelsError ? <Text color={color.faint}>{glyph.err} {truncate(panel.modelsError, Math.max(8, innerW - 4))}</Text> : <ShimmerText text="loading available models…" />)
              : <Text color={color.faint}>no models match “{ph.filter}”</Text>
          ) : (
            slice.map((m, i) => {
              const sel = start + i === idx;
              return (
                <Text key={m} wrap="truncate-end" backgroundColor={sel ? color.accentBg : undefined}>
                  <Text color={sel ? color.accent : color.faint}>{sel ? `${glyph.select} ` : "  "}</Text>
                  <Text color={color.text} bold={sel}>{truncate(m, Math.max(8, innerW - 4))}</Text>
                </Text>
              );
            })
          )}
        </Box>
      );
      hint = `filter: ${ph.filter || "(type to filter)"}  ·  ↑↓ · ⏎ select · esc back`;
    } else if (ph.phase === "capacity-type") {
      const capacityTypes = [
        { id: "Standard", note: "pay-per-token · shared" },
        { id: "GlobalStandard", note: "lower latency · global routing" },
        { id: "ProvisionedManaged", note: "dedicated PTU · reserved capacity" },
      ];
      const idx = clampIndex(ph.index, capacityTypes.length);
      body = (
        <Box flexDirection="column" paddingX={1}>
          <Text color={color.faint}>deploy: <Text color={color.text}>{ph.selectedModel}</Text></Text>
          <Box marginTop={1} flexDirection="column">
            {capacityTypes.map((t, i) => {
              const sel = i === idx;
              return (
                <Text key={t.id} wrap="truncate-end" backgroundColor={sel ? color.accentBg : undefined}>
                  <Text color={sel ? color.accent : color.faint}>{sel ? `${glyph.select} ` : "  "}</Text>
                  <Text color={color.text} bold={sel}>{t.id.padEnd(22)}</Text>
                  <Text color={color.faint}>{t.note}</Text>
                </Text>
              );
            })}
          </Box>
        </Box>
      );
      hint = "↑↓ · ⏎ select · esc back";
    } else if (ph.phase === "deploy-name") {
      const fw = fieldWindow(ph.fieldEdit.value, ph.fieldEdit.cursor, Math.max(8, innerW - 4));
      body = (
        <Box flexDirection="column" paddingX={1}>
          <Text color={color.faint}>
            model: <Text color={color.text}>{ph.selectedModel}</Text>
            {"  ·  "}
            capacity: <Text color={color.text}>{ph.capacityType}</Text>
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Text color={color.accent} bold>deployment name</Text>
            <Box>
              <Text color={color.faint}>{glyph.prompt} </Text>
              <Text color={color.text}>{fw.pre}</Text>
              <Text color={color.accent} inverse>{fw.at}</Text>
              <Text color={color.text}>{fw.post}</Text>
            </Box>
            {!ph.fieldEdit.value ? <Text color={color.faint}>  e.g. gpt-4o-deployment</Text> : null}
            {ph.fieldError ? <Text color={color.err}>  {glyph.err} {ph.fieldError}</Text> : null}
          </Box>
          {panel.submitting ? <Box marginTop={1}><Text color={color.faint}>deploying…</Text></Box> : null}
        </Box>
      );
      hint = "⏎ deploy · esc back";
    } else if (ph.phase === "confirm-delete") {
      // Show what the user is about to destroy, not just its name.
      const dep = panel.deployments?.find((d) => d.id === ph.deploymentId);
      body = (
        <Box flexDirection="column" paddingX={1}>
          <Text>delete <Text color={color.err} bold>{truncate(ph.deploymentId, Math.max(8, innerW - 10))}</Text>?</Text>
          {dep ? (
            <Text color={color.faint}>
              {"  "}model: <Text color={color.text}>{truncate(dep.model, 28)}</Text>
              {"  ·  "}status: <Text color={dep.status === "failed" ? color.err : dep.status === "succeeded" ? color.ok : color.warn}>{dep.status}</Text>
              {dep.capacityUnits !== undefined ? <Text>  ·  {dep.capacityUnits}PTU</Text> : null}
            </Text>
          ) : null}
          <Box marginTop={1}><Text color={color.faint}>this cannot be undone</Text></Box>
          <Box marginTop={1}>
            <Text color={color.err} bold>⏎ confirm</Text>
            <Text color={color.faint}>  · n / esc cancel</Text>
          </Box>
        </Box>
      );
      hint = "⏎ confirm delete · n / esc cancel";
    }
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box width={width} paddingX={1} justifyContent="space-between">
        <Text color={color.accent} bold>{panel.title}</Text>
        <Text color={color.faint}> </Text>
      </Box>
      <Box flexDirection="column" width={width} height={bodyH}>{body}</Box>
      <Box width={width} paddingX={1}>
        <Text color={color.faint}>{hint}</Text>
      </Box>
    </Box>
  );
}
