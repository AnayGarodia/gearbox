// Dismissible command panel — the model + pure helpers behind the Esc-closable
// overlay that big "info dump" commands (/help, /account, /context, /cost, /keys,
// /model, /memory) open instead of dumping into the transcript. Fullscreen only
// (inline mode keeps printing inline — it has native scrollback). Kept pure and
// tested; the React/Ink rendering lives in components/Panel.tsx and the wiring in
// App.tsx.
import type { Item } from "./types.ts";
import type { Edit } from "./input.ts";
import type { AddSpec } from "../accounts/add-spec.ts";

export interface PanelModelRow {
  id: string;
  label: string;
  provider: string;
  current: boolean;
}

export interface PanelSessionRow {
  id: string;
  when: string; // relative time, e.g. "19h ago"
  turns: number;
  title: string;
}

export type PanelState =
  // view-only: a prebuilt transcript Item rendered + scrolled in the panel
  | { kind: "static"; title: string; items: Item[]; scroll: number }
  // interactive list: switch the selected account
  | { kind: "accounts"; title: string; index: number }
  // interactive list: pin the selected model, with type-to-filter
  | { kind: "models"; title: string; index: number; filter: string }
  // interactive list: load the selected saved session
  | { kind: "sessions"; title: string; index: number }
  // guided add-account wizard: pick a provider, then step through its fields
  | {
      kind: "wizard";
      title: string;
      wizardPhase:
        | { phase: "pick"; index: number; filter: string }
        | { phase: "field"; specId: string; fieldIndex: number; fieldEdit: Edit; fieldError: string | null; filled: Record<string, string> };
    };

/** The wizard panel narrowed from the union (for the pure reducers below). */
export type WizardPanel = Extract<PanelState, { kind: "wizard" }>;

export const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(n, hi));

/** Clamp a selection index into [0, count-1] (0 when empty). */
export const clampIndex = (i: number, count: number): number => (count <= 0 ? 0 : clamp(i, 0, count - 1));

/** Clamp a scroll offset into [0, max]. */
export const clampScroll = (s: number, max: number): number => clamp(s, 0, Math.max(0, max));

/** The body area of a panel of total `height` (minus the header + footer rows). */
export const panelBodyHeight = (height: number): number => Math.max(1, height - 2);

/** First row to show so `index` stays visible in a `viewH`-row window. Keeps the
 *  selection on screen when arrowing through a list longer than the panel. */
export function windowStart(index: number, count: number, viewH: number): number {
  if (count <= viewH) return 0;
  const half = Math.floor(viewH / 2);
  return clamp(index - half, 0, count - viewH);
}

/** Filter model rows by a typed query (substring on label/id/provider, case-insensitive). */
export function filterModelRows(rows: PanelModelRow[], filter: string): PanelModelRow[] {
  const q = filter.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => r.label.toLowerCase().includes(q) || r.id.toLowerCase().includes(q) || r.provider.toLowerCase().includes(q));
}

/** Append a printable char to a panel's model filter (and reset selection to top). */
export function appendFilter(panel: Extract<PanelState, { kind: "models" }>, ch: string): PanelState {
  return { ...panel, filter: panel.filter + ch, index: 0 };
}

/** Backspace the model filter (reset selection to top). */
export function backspaceFilter(panel: Extract<PanelState, { kind: "models" }>): PanelState {
  return { ...panel, filter: panel.filter.slice(0, -1), index: 0 };
}

// ── Guided add-account wizard reducers (pure; tested in test/wizard-panel.test.ts) ──
// The wizard has two phases: "pick" (choose a provider from a filterable list) and
// "field" (type one field at a time). Field text is driven by input.ts `applyKey` in
// App; these helpers just store the resulting Edit and walk the field index. When
// fieldIndex reaches spec.fields.length, that is the COMPLETE sentinel — App reads
// `filled` and calls spec.build().

const emptyEdit = (): Edit => ({ value: "", cursor: 0 });

/** Open the wizard at the provider-pick phase. */
export function wizardOpen(title: string): WizardPanel {
  return { kind: "wizard", title, wizardPhase: { phase: "pick", index: 0, filter: "" } };
}

/** Move the pick selection (clamped into the visible count). */
export function wizardPickMove(p: WizardPanel, delta: number, count: number): WizardPanel {
  if (p.wizardPhase.phase !== "pick") return p;
  return { ...p, wizardPhase: { ...p.wizardPhase, index: clampIndex(p.wizardPhase.index + delta, count) } };
}

/** Append a char to the pick filter (reset selection to top). */
export function wizardPickFilter(p: WizardPanel, ch: string): WizardPanel {
  if (p.wizardPhase.phase !== "pick") return p;
  return { ...p, wizardPhase: { ...p.wizardPhase, filter: p.wizardPhase.filter + ch, index: 0 } };
}

/** Backspace the pick filter (reset selection to top). */
export function wizardPickBackspace(p: WizardPanel): WizardPanel {
  if (p.wizardPhase.phase !== "pick") return p;
  return { ...p, wizardPhase: { ...p.wizardPhase, filter: p.wizardPhase.filter.slice(0, -1), index: 0 } };
}

/** Confirm the picked provider → enter the field phase at field 0. */
export function wizardPickConfirm(p: WizardPanel, specId: string): WizardPanel {
  return { ...p, wizardPhase: { phase: "field", specId, fieldIndex: 0, fieldEdit: emptyEdit(), fieldError: null, filled: {} } };
}

/** Store new Edit state for the current field (clears any prior inline error). */
export function wizardFieldEdit(p: WizardPanel, edit: Edit): WizardPanel {
  if (p.wizardPhase.phase !== "field") return p;
  return { ...p, wizardPhase: { ...p.wizardPhase, fieldEdit: edit, fieldError: null } };
}

/** Set an inline validation error on the current field. */
export function wizardFieldError(p: WizardPanel, message: string): WizardPanel {
  if (p.wizardPhase.phase !== "field") return p;
  return { ...p, wizardPhase: { ...p.wizardPhase, fieldError: message } };
}

/** Confirm the current field. On a validation failure, sets the inline error and
 *  stays put. On success, stores the value and advances; fieldIndex === fields.length
 *  is the completion sentinel (see wizardIsComplete). */
export function wizardFieldAdvance(p: WizardPanel, spec: AddSpec): WizardPanel {
  if (p.wizardPhase.phase !== "field") return p;
  const ph = p.wizardPhase;
  const field = spec.fields[ph.fieldIndex];
  if (!field) return p;
  const err = field.validate(ph.fieldEdit.value);
  if (err) return { ...p, wizardPhase: { ...ph, fieldError: err } };
  const filled = { ...ph.filled, [field.key]: ph.fieldEdit.value };
  return { ...p, wizardPhase: { ...ph, filled, fieldIndex: ph.fieldIndex + 1, fieldEdit: emptyEdit(), fieldError: null } };
}

/** True once every field has been confirmed (ready to build). */
export function wizardIsComplete(p: WizardPanel, spec: AddSpec): boolean {
  return p.wizardPhase.phase === "field" && p.wizardPhase.fieldIndex >= spec.fields.length;
}

/** Step back one field (restoring its prior value), or from the first field return
 *  to the provider-pick phase. Pass `spec` to restore the previous field's value. */
export function wizardBack(p: WizardPanel, spec?: AddSpec): WizardPanel {
  if (p.wizardPhase.phase !== "field") return p;
  const ph = p.wizardPhase;
  if (ph.fieldIndex === 0) return wizardOpen(p.title);
  const prevIndex = ph.fieldIndex - 1;
  const prevKey = spec?.fields[prevIndex]?.key;
  const prevVal = prevKey ? ph.filled[prevKey] ?? "" : "";
  return { ...p, wizardPhase: { ...ph, fieldIndex: prevIndex, fieldEdit: { value: prevVal, cursor: prevVal.length }, fieldError: null } };
}
