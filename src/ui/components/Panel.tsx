import React from "react";
import { Box, Text } from "ink";
import { color, glyph, THEMES } from "../theme.ts";
import { Viewport } from "./Viewport.tsx";
import { ShimmerText } from "./Shimmer.tsx";
import { itemsToLines, type Line } from "../lines.ts";
import { panelBodyHeight, windowStart, filterModelRows, clampIndex, truncate, fieldWindow, diffFileRow, type PanelState, type PanelModelRow, type PanelSessionRow, type AccountDetailViewData } from "../panel.ts";
import { filterAddSpecs, type AddSpec } from "../../accounts/add-spec.ts";
import { ListRow, HintLine, Field } from "./ui.tsx";
import { GHOST_LOOKS } from "./Mascot.tsx";
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
              <ListRow key="__add__" selected={sel} label="+ add an account" labelColor={color.accent} detail="any provider · subscription · key" />
            );
          }
          const r = row.r;
          // Status word only on the row (the active account reads from its bold
          // name + "current" status word); commands live on the hint line.
          return (
            <ListRow key={r.alias} selected={sel} label={r.name} labelWidth={labelPad} bold={r.active}>
              <Text color={color.faint}>  {r.type}</Text>
              <Text color={accountStateColor(r.status)}>  {r.active ? "current" : r.status}</Text>
              {r.detail ? <Text color={color.faint}>  · {r.detail}</Text> : null}
            </ListRow>
          );
        })}
      </Box>
    );
    // The command for the SELECTED row lives down here, not crowded into the row.
    hint = "↑↓ move · ⏎ select · → detail · esc close";
    const selRow = items[idx];
    if (selRow && !selRow.add && selRow.r.type === "subscription" && !(selRow.r.detail && selRow.r.detail.includes("@"))) {
      hint = `/account login ${selRow.r.alias} to identify · ` + hint;
    }
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
              <ListRow
                key={r.id}
                selected={sel}
                marker={r.pinned ? { text: glyph.on + " ", color: color.warn } : undefined}
                label={truncate(r.title || "(untitled)", 52)}
                labelColor={armed ? color.err : color.text}
                detail={armed ? "· press d again to delete" : `· ${r.turns} turn${r.turns === 1 ? "" : "s"} · ${r.when}`}
                detailColor={armed ? color.err : color.faint}
              />
            );
          })
        )}
        {cur?.preview && (cur.preview.ask || cur.preview.reply) ? (
          // ONE quote spine for the whole preview; the reply continues under it
          // with the same indent so both lines truncate at the same column.
          <Box flexDirection="column" marginTop={1}>
            <Text wrap="truncate-end"><Text color={color.faint}>{glyph.quote} </Text><Text color={color.user}>{truncate(cur.preview.ask, Math.max(8, innerW - 2))}</Text></Text>
            {cur.preview.reply ? <Text wrap="truncate-end"><Text>{"  "}</Text><Text color={color.faint}>{truncate(cur.preview.reply, Math.max(8, innerW - 2))}</Text></Text> : null}
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
          slice.map((s, i) => (
            <ListRow key={s.id} selected={start + i === idx} label={s.label} labelWidth={24} detail={s.summary} />
          ))
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
          <Field
            label={field?.label ?? ""}
            note={field?.secret ? "(visible as typed)" : undefined}
            value={fieldWindow(ph.fieldEdit.value, ph.fieldEdit.cursor, Math.max(8, innerW - 4))}
            placeholder={field?.placeholder}
            error={ph.fieldError}
          />
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
              <ListRow key={r.id} selected={sel} label={r.label} labelWidth={28} labelColor={pinned ? color.ok : color.text} bold={pinned}>
                <Text color={color.faint}>{r.provider}</Text>
                {pinned ? <Text color={color.ok}>  {glyph.on} pinned</Text> : null}
              </ListRow>
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
            <ListRow key={t.name} selected={sel} label={t.label} labelWidth={20}>
              {/* A swatch of the palette's own semantics — readable in ANY theme. */}
              <Text color={t.palette.accent}>{glyph.on}</Text>
              <Text color={t.palette.ok}>{glyph.on}</Text>
              <Text color={t.palette.warn}>{glyph.on}</Text>
              <Text color={t.palette.err}>{glyph.on}</Text>
              <Text color={t.palette.path}>{glyph.on}</Text>
              <Text color={color.faint}>  {t.hint}</Text>
              {active ? <Text color={color.ok}>  {glyph.check} current</Text> : null}
            </ListRow>
          );
        })}
        <Box marginTop={1}><Text color={color.faint}>the whole screen previews as you move</Text></Box>
      </Box>
    );
    hint = "↑↓ preview live · ⏎ keep · esc revert";
  } else if (panel.kind === "ghosts") {
    // Boo's wardrobe: skins (palettes) + personas (costumes) in one gallery.
    // ↑↓ previews live on the splash; ⏎ keeps it as the resting look.
    const looks = GHOST_LOOKS;
    const idx = clampIndex(panel.index, looks.length);
    const start = windowStart(idx, looks.length, bodyH);
    const slice = looks.slice(start, start + bodyH);
    body = (
      <Box flexDirection="column" paddingX={1}>
        {slice.map((l, i) => {
          const sel = start + i === idx;
          const active = l.value === panel.original;
          return (
            <ListRow key={l.value} selected={sel} label={l.label} labelWidth={14}>
              <Text color={color.faint}>{l.persona ? "persona" : "skin   "}</Text>
              <Text color={color.faint}>  {l.hint}</Text>
              {active ? <Text color={color.ok}>  {glyph.check} current</Text> : null}
            </ListRow>
          );
        })}
        <Box marginTop={1}><Text color={color.faint}>Boo previews on the home screen as you move</Text></Box>
      </Box>
    );
    hint = "↑↓ preview live · ⏎ keep · esc revert";
  } else if (panel.kind === "diff") {
    // File list on top (windowed, ≤1/3 of the body), the selected file's unified
    // diff beneath. +/- lines tinted; the file list and the pane scroll separately.
    if (!panel.files.length) {
      body = (
        <Box paddingX={1}>
          <Text color={color.faint}>no changes in this scope</Text>
        </Box>
      );
      hint = "esc close";
    } else {
      const listH = Math.max(1, Math.min(panel.files.length, Math.floor(bodyH / 3)));
      const diffH = Math.max(1, bodyH - listH - 1);
      const idx = clampIndex(panel.index, panel.files.length);
      const start = windowStart(idx, panel.files.length, listH);
      const slice = panel.files.slice(start, start + listH);
      const diffLines = panel.diff === null ? null : panel.diff.split("\n");
      const visible = diffLines ? diffLines.slice(panel.scroll, panel.scroll + diffH) : [];
      const tint = (l: string): string =>
        l.startsWith("+") ? color.ok : l.startsWith("-") ? color.err : l.startsWith("@@") ? color.accent : color.dim;
      body = (
        <Box flexDirection="column" paddingX={1}>
          {slice.map((f, i) => (
            <ListRow key={f.path} selected={start + i === idx} label={diffFileRow(f, Math.max(16, innerW - 4))} />
          ))}
          <Text color={color.faint}>{"─".repeat(Math.max(4, innerW - 2))}</Text>
          {diffLines === null ? (
            <Text color={color.faint}>loading…</Text>
          ) : (
            visible.map((l, i) => (
              <Text key={panel.scroll + i} color={tint(l)}>{truncate(l, Math.max(8, innerW - 2))}</Text>
            ))
          )}
        </Box>
      );
      const scrollable = diffLines !== null && diffLines.length > diffH;
      hint = `↑↓ file${scrollable ? " · PgUp PgDn scroll diff" : ""} · esc close`;
    }
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
                <ListRow key={d.id} selected={sel} label={d.id} labelWidth={idW} labelColor={failed ? color.err : color.text}>
                  <Text color={color.faint}>  {truncate(d.model, 22)}</Text>
                  <Text color={failed ? color.err : d.status === "succeeded" ? color.ok : color.warn}>  {d.status}</Text>
                  {d.capacityUnits !== undefined ? <Text color={color.faint}>  {d.capacityUnits}PTU</Text> : null}
                </ListRow>
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
            slice.map((m, i) => (
              <ListRow key={m} selected={start + i === idx} label={truncate(m, Math.max(8, innerW - 4))} />
            ))
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
            {capacityTypes.map((t, i) => (
              <ListRow key={t.id} selected={i === idx} label={t.id} labelWidth={22} detail={t.note} />
            ))}
          </Box>
        </Box>
      );
      hint = "↑↓ · ⏎ select · esc back";
    } else if (ph.phase === "deploy-name") {
      body = (
        <Box flexDirection="column" paddingX={1}>
          <Text color={color.faint}>
            model: <Text color={color.text}>{ph.selectedModel}</Text>
            {"  ·  "}
            capacity: <Text color={color.text}>{ph.capacityType}</Text>
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Field
              label="deployment name"
              value={fieldWindow(ph.fieldEdit.value, ph.fieldEdit.cursor, Math.max(8, innerW - 4))}
              placeholder="gpt-4o-deployment"
              error={ph.fieldError}
            />
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

  // The opencode modal chrome: the title as an element-layer chip top-left, a
  // muted `esc` affordance top-right on the SAME row; the detailed key hint
  // stays on the bottom row. Visual only — the row budget (panelBodyHeight =
  // height − 2) and all key handling are unchanged.
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box width={width} paddingX={1} justifyContent="space-between">
        <Text color={color.accent} bold backgroundColor={color.elementBg}>{` ${panel.title} `}</Text>
        <Text color={color.faint}>esc</Text>
      </Box>
      <Box flexDirection="column" width={width} height={bodyH}>{body}</Box>
      <Box width={width} paddingX={1}>
        <HintLine text={hint} />
      </Box>
    </Box>
  );
}
