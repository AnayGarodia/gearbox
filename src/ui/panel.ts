// Dismissible command panel — the model + pure helpers behind the Esc-closable
// overlay that big "info dump" commands (/help, /account, /context, /cost, /keys,
// /model, /memory) open instead of dumping into the transcript. Fullscreen only
// (inline mode keeps printing inline — it has native scrollback). Kept pure and
// tested; the React/Ink rendering lives in components/Panel.tsx and the wiring in
// App.tsx.
import type { Item } from "./types.ts";
import type { Edit } from "./input.ts";
import type { AddSpec } from "../accounts/add-spec.ts";
import type { AzureDeploymentInfo } from "../accounts/manage.ts";

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
    }
  // git confirm: review/edit a generated commit message or PR title before it runs
  | {
      kind: "git-confirm";
      title: string;
      mode: "commit" | "pr";
      subject: Edit; // editable first line (commit subject / PR title)
      body: string; // generated body shown read-only (r regenerates both)
      files: string[]; // what's staged / what the PR contains
      stat: string; // diffstat summary line(s)
      submitting: boolean;
      error?: string;
    }
  // account detail + Azure management: browse deployments, deploy, delete
  | {
      kind: "account-detail";
      title: string;
      accountId: string;
      // null = loading, [] or populated = loaded
      deployments: AzureDeploymentInfo[] | null;
      availableModels: string[] | null;
      loadError?: string;
      modelsError?: string; // the models load failed (deploy disabled until r retries)
      refreshing: boolean; // a reload is in flight; the stale list stays visible
      submitting: boolean;
      index: number; // selection in browse list
      detailPhase:
        | { phase: "browse" }
        | { phase: "deploy-pick"; filter: string; index: number }
        | { phase: "capacity-type"; selectedModel: string; index: number }
        | { phase: "deploy-name"; selectedModel: string; capacityType: string; fieldEdit: Edit; fieldError: string | null }
        | { phase: "confirm-delete"; deploymentId: string };
    };

/** The wizard panel narrowed from the union (for the pure reducers below). */
export type WizardPanel = Extract<PanelState, { kind: "wizard" }>;

export const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(n, hi));

/** Shared ellipsis truncation — one glyph, one rule, everywhere a panel clips. */
export const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s);

/** Horizontal window for a single-line field input: slide a `w`-wide window so
 *  the caret stays visible. `at` is the char under the cursor (a space when the
 *  cursor sits past the end), rendered inverse by the caller. */
export function fieldWindow(value: string, cursor: number, w: number): { pre: string; at: string; post: string } {
  const width = Math.max(3, w);
  const cur = clamp(cursor, 0, value.length);
  // Window start: keep the caret in view, preferring to show trailing context.
  let start = 0;
  if (value.length + 1 > width) {
    start = clamp(cur - Math.floor(width * 0.75), 0, Math.max(0, value.length + 1 - width));
  }
  const visible = value.slice(start, start + width);
  const caretIn = cur - start;
  return {
    pre: visible.slice(0, caretIn),
    at: caretIn < visible.length ? visible[caretIn]! : " ",
    post: caretIn < visible.length ? visible.slice(caretIn + 1) : "",
  };
}

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

const emptyEdit = (): Edit => ({ value: "", cursor: 0 }); // shared by wizard + detail reducers

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

// ── Git confirm reducers (pure; tested in test/git-confirm-panel.test.ts) ────
// One review step between "the model wrote this" and "git ran it": the subject
// is editable in place (applyKey-driven, like the deploy-name field), the body
// is read-only (r regenerates both), ⏎ executes, esc cancels.

export type GitConfirmPanel = Extract<PanelState, { kind: "git-confirm" }>;

export function gitConfirmOpen(opts: { mode: "commit" | "pr"; subject: string; body: string; files: string[]; stat: string }): GitConfirmPanel {
  return {
    kind: "git-confirm",
    title: opts.mode === "commit" ? "commit · review the message" : "pull request · review title & body",
    mode: opts.mode,
    subject: { value: opts.subject, cursor: opts.subject.length },
    body: opts.body,
    files: opts.files,
    stat: opts.stat,
    submitting: false,
  };
}

export function gitConfirmEdit(p: GitConfirmPanel, edit: Edit): GitConfirmPanel {
  return { ...p, subject: edit, error: undefined };
}

export function gitConfirmSetSubmitting(p: GitConfirmPanel, submitting: boolean): GitConfirmPanel {
  // A retry clears the stale error — otherwise the error row and the
  // submitting row render together and overflow the body's row budget.
  return { ...p, submitting, error: undefined };
}

export function gitConfirmError(p: GitConfirmPanel, message: string): GitConfirmPanel {
  return { ...p, submitting: false, error: message };
}

/** A subject fit to execute: non-empty after trimming. */
export function gitConfirmReady(p: GitConfirmPanel): boolean {
  return p.subject.value.trim().length > 0;
}

/** The full message git/gh receives: subject + blank line + body (when any). */
export function gitConfirmMessage(p: GitConfirmPanel): string {
  const subject = p.subject.value.trim();
  const body = p.body.trim();
  return body ? `${subject}\n\n${body}` : subject;
}

// ── Account detail + Azure management reducers (pure; tested in test/account-detail-panel.test.ts) ──
// State machine: browse ↔ deploy-pick → capacity-type → deploy-name → complete sentinel
//                browse ↔ confirm-delete → complete sentinel
// Complete sentinels are checked by App after detailNameAdvance / detailConfirmDelete.

export type AccountDetailPanel = Extract<PanelState, { kind: "account-detail" }>;

/** Pre-resolved view data for the account detail panel — keeps raw Account out of the render layer. */
export interface AccountDetailViewData {
  id: string;
  label: string;
  provider: string;
  isAzure: boolean;
  endpoint: string;
  healthState?: string;
  healthCheckedAt?: number;
  lastUsedAt?: number;
}

/** Open an account detail panel at the browse phase (loading state). */
export function detailOpen(accountId: string, title: string): AccountDetailPanel {
  return {
    kind: "account-detail",
    title,
    accountId,
    deployments: null,
    availableModels: null,
    refreshing: false,
    submitting: false,
    index: 0,
    detailPhase: { phase: "browse" },
  };
}

/** Store fetched deployments (clears loading + refreshing state for the list). */
export function detailSetDeployments(p: AccountDetailPanel, deployments: AzureDeploymentInfo[]): AccountDetailPanel {
  return { ...p, deployments, refreshing: false, loadError: undefined };
}

/** Store fetched available models (clears a prior models error). */
export function detailSetAvailableModels(p: AccountDetailPanel, models: string[]): AccountDetailPanel {
  return { ...p, availableModels: models, modelsError: undefined };
}

/** Begin a reload: the stale list stays visible under a "refreshing…" note. */
export function detailStartRefresh(p: AccountDetailPanel): AccountDetailPanel {
  return { ...p, refreshing: true, loadError: undefined };
}

/** Store a load error. An initial-load failure shows the bare error state; a
 *  failed REFRESH keeps the stale list visible alongside the error note. */
export function detailSetError(p: AccountDetailPanel, note: string): AccountDetailPanel {
  return { ...p, refreshing: false, loadError: note };
}

/** The available-models load failed: deploy is disabled until r retries. */
export function detailSetModelsError(p: AccountDetailPanel, note: string): AccountDetailPanel {
  return { ...p, modelsError: note };
}

/** Move the browse-phase selection (clamped). */
export function detailMoveIndex(p: AccountDetailPanel, delta: number, count: number): AccountDetailPanel {
  return { ...p, index: clampIndex(p.index + delta, count) };
}

/** Start the deploy flow. No-op if availableModels is not yet loaded. */
export function detailStartDeploy(p: AccountDetailPanel): AccountDetailPanel {
  if (p.availableModels === null) return p; // invariant: disabled while loading
  return { ...p, detailPhase: { phase: "deploy-pick", filter: "", index: 0 } };
}

/** Append a char to the deploy-pick filter. */
export function detailDeployFilter(p: AccountDetailPanel, ch: string): AccountDetailPanel {
  if (p.detailPhase.phase !== "deploy-pick") return p;
  return { ...p, detailPhase: { ...p.detailPhase, filter: p.detailPhase.filter + ch, index: 0 } };
}

/** Backspace the deploy-pick filter. */
export function detailDeployBackspace(p: AccountDetailPanel): AccountDetailPanel {
  if (p.detailPhase.phase !== "deploy-pick") return p;
  return { ...p, detailPhase: { ...p.detailPhase, filter: p.detailPhase.filter.slice(0, -1), index: 0 } };
}

/** Move the deploy-pick selection (clamped to filtered list). */
export function detailDeployMove(p: AccountDetailPanel, delta: number, count: number): AccountDetailPanel {
  if (p.detailPhase.phase !== "deploy-pick") return p;
  return { ...p, detailPhase: { ...p.detailPhase, index: clampIndex(p.detailPhase.index + delta, count) } };
}

/** Confirm model selection → enter capacity-type phase. App passes the model id (already dereferenced). */
export function detailPickCapacity(p: AccountDetailPanel, modelId: string): AccountDetailPanel {
  return { ...p, detailPhase: { phase: "capacity-type", selectedModel: modelId, index: 0 } };
}

/** Move the capacity-type selection. */
export function detailCapacityMove(p: AccountDetailPanel, delta: number): AccountDetailPanel {
  if (p.detailPhase.phase !== "capacity-type") return p;
  return { ...p, detailPhase: { ...p.detailPhase, index: clampIndex(p.detailPhase.index + delta, 3) } };
}

/** Confirm capacity type → enter deploy-name phase. App passes the capacity type string. */
export function detailConfirmCapacity(p: AccountDetailPanel, capacityType: string): AccountDetailPanel {
  if (p.detailPhase.phase !== "capacity-type") return p;
  return { ...p, detailPhase: { phase: "deploy-name", selectedModel: p.detailPhase.selectedModel, capacityType, fieldEdit: emptyEdit(), fieldError: null } };
}

/** Update the deployment name field. */
export function detailNameEdit(p: AccountDetailPanel, edit: Edit): AccountDetailPanel {
  if (p.detailPhase.phase !== "deploy-name") return p;
  return { ...p, detailPhase: { ...p.detailPhase, fieldEdit: edit, fieldError: null } };
}

// Azure deployment name: 2–64 chars, alphanumeric + hyphens, no leading/trailing hyphens.
// 2-64 chars (the first alternative requires ≥2; no 1-char escape hatch —
// the inline error message promises the same bounds).
const AZURE_DEPLOYMENT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}[a-zA-Z0-9]$/;

/** Validate and advance the deploy-name field. Sets fieldError on failure.
 *  When valid, the fieldEdit.value is the deployment name — App checks detailIsNameComplete. */
export function detailNameAdvance(p: AccountDetailPanel): AccountDetailPanel {
  if (p.detailPhase.phase !== "deploy-name") return p;
  const name = p.detailPhase.fieldEdit.value.trim();
  if (!name) return { ...p, detailPhase: { ...p.detailPhase, fieldError: "required" } };
  if (!AZURE_DEPLOYMENT_NAME_RE.test(name)) {
    return { ...p, detailPhase: { ...p.detailPhase, fieldError: "2–64 chars, letters/numbers/hyphens, no leading/trailing hyphens" } };
  }
  // No phase transition here — App reads detailIsNameComplete and calls createDeployment.
  return p;
}

/** True when the deploy-name is valid and ready to submit. */
export function detailIsNameComplete(p: AccountDetailPanel): boolean {
  if (p.detailPhase.phase !== "deploy-name") return false;
  return AZURE_DEPLOYMENT_NAME_RE.test(p.detailPhase.fieldEdit.value.trim());
}

/** Set submitting flag (in-flight API call). */
export function detailSetSubmitting(p: AccountDetailPanel, submitting: boolean): AccountDetailPanel {
  return { ...p, submitting };
}

/** Start the delete confirmation flow for a deployment. */
export function detailStartDelete(p: AccountDetailPanel, deploymentId: string): AccountDetailPanel {
  return { ...p, detailPhase: { phase: "confirm-delete", deploymentId } };
}

/** True when confirm-delete has been confirmed by the user (App triggers deleteDeployment). */
export function detailIsDeleteComplete(p: AccountDetailPanel): boolean {
  return p.detailPhase.phase === "confirm-delete";
}

/** Optimistically remove a deployment from the list (before reload). */
export function detailOptimisticRemove(p: AccountDetailPanel, deploymentId: string): AccountDetailPanel {
  return { ...p, deployments: p.deployments?.filter((d) => d.id !== deploymentId) ?? null };
}

/** Navigate back one step in the detail flow.
 *  confirm-delete → browse; deploy-name → capacity-type; capacity-type → deploy-pick;
 *  deploy-pick → browse; browse → no-op (App closes the panel). */
export function detailBack(p: AccountDetailPanel): AccountDetailPanel {
  const ph = p.detailPhase;
  if (ph.phase === "confirm-delete") return { ...p, detailPhase: { phase: "browse" } };
  if (ph.phase === "deploy-name") return { ...p, detailPhase: { phase: "capacity-type", selectedModel: ph.selectedModel, index: 0 } };
  if (ph.phase === "capacity-type") return { ...p, detailPhase: { phase: "deploy-pick", filter: "", index: 0 } };
  if (ph.phase === "deploy-pick") return { ...p, detailPhase: { phase: "browse" } };
  return p; // browse → App closes panel
}
