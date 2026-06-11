/**
 * permission.ts - Permission broker for mutating agent actions.
 *
 * Pattern overview
 * ----------------
 * Every tool that can change state (write_file, edit_file, run_shell) calls
 * requestPermission() before acting. requestPermission is async and blocks
 * until either:
 *   a) auto-approval applies (yolo mode or a standing per-kind grant), or
 *   b) the registered UI handler resolves a PermDecision for the request.
 *
 * The broker is a module-level singleton. There is exactly one handler slot,
 * one yolo flag, and one set of standing per-kind grants. This keeps the
 * call-sites simple: tools call requestPermission() with no knowledge of
 * whether a TUI, a headless script, or a test harness is on the other end.
 *
 * Gate lifecycle
 * --------------
 * 1. On startup the handler is null. With no handler installed, every request
 *    is auto-approved so the agent works unchanged in non-interactive contexts
 *    (CI, scripts, tests).
 * 2. The TUI installs a handler via setPermissionHandler() when it starts.
 *    The handler shows a prompt and returns one of four decisions:
 *      "once"   - approve this single action only.
 *      "always" - approve all future actions of the same kind (write, edit,
 *                 or shell) for the remainder of the session. The kind is
 *                 added to the `granted` set and never prompted again.
 *      "all"    - approve everything for the rest of the session (sets yolo).
 *      "deny"   - reject this action; the tool throws DENIED.
 * 3. The handler can be swapped or removed at any time (e.g. when the TUI
 *    unmounts), reverting to auto-approve behavior.
 *
 * Yolo mode (auto-approve all)
 * ----------------------------
 * Yolo bypasses every permission prompt for the lifetime of the session. It
 * can be enabled in three ways:
 *   - The user picks "allow all" in any permission prompt (decision "all").
 *   - The user runs the /yolo slash command.
 *   - The --yolo CLI flag is passed at startup.
 *
 * Yolo is intentionally opt-in and session-scoped. resetPermissions() clears
 * both yolo and all standing grants, which is useful in tests between cases.
 */

import { ruleFor, loadPermissionRules } from "./permission-rules.ts";
import { emitHook } from "./plugins.ts";

/** The category of action being requested. Drives per-kind standing grants. */
export type PermKind = "write" | "edit" | "shell";

/** Describes a single permission request shown to the user. */
export interface PermRequest {
  kind: PermKind;
  /** Short label displayed in the prompt, e.g. "Run a shell command". */
  title: string;
  /** The concrete subject of the action: a file path, or the shell command. */
  detail: string;
  /** Workspace root the request originates from (set by the toolset). With
   *  multiple sessions mounted (conductor tabs), this routes the prompt to the
   *  tab that owns the workspace instead of whichever registered last. */
  root?: string;
  /** Always show the prompt, even under yolo or a standing grant. Used for
   *  sandbox-escape escalation: auto-approving everything is exactly when the
   *  sandbox is the only guardrail left, so leaving it must stay a deliberate
   *  human decision. A written rules "deny" still refuses outright. */
  forceAsk?: boolean;
}

/**
 * The four possible outcomes a permission handler can return.
 *   "once"   - allow this specific action, then ask again next time.
 *   "always" - allow all future actions of this kind (standing grant).
 *   "all"    - allow all future actions of every kind (yolo).
 *   "deny"   - reject this action; requestPermission returns false.
 */
export type PermDecision = "once" | "always" | "all" | "deny";

/** Callback installed by the UI layer to resolve permission prompts. */
type Handler = (req: PermRequest) => Promise<PermDecision>;

// Module-level broker state. Single handler, per-kind standing grants, yolo flag.
let handler: Handler | null = null;
const granted = new Set<PermKind>();
let yolo = false;

// Pre-mutation hook: runs on EVERY mutating request BEFORE any decision logic
// (yolo, rules, and standing grants included — they all still mutate). The App
// uses it to take a lazy whole-tree turn checkpoint so /undo covers shell-side
// deletes/renames. Synchronous and exception-isolated: it can never block or
// break the gate.
let preMutation: ((req: PermRequest) => void) | null = null;
export function setPreMutationHook(fn: ((req: PermRequest) => void) | null): void {
  preMutation = fn;
}
// Per-root pre-mutation hooks (conductor tabs): each session checkpoints ITS
// tree. A request with a root runs that root's hook; otherwise the global one.
const rootPreMutation = new Map<string, (req: PermRequest) => void>();
export function registerPreMutationHook(root: string, fn: ((req: PermRequest) => void) | null): void {
  if (fn) rootPreMutation.set(root, fn);
  else rootPreMutation.delete(root);
}

/**
 * Install or remove the permission handler.
 * Pass null to revert to headless auto-approve behavior.
 */
export function setPermissionHandler(h: Handler | null): void {
  handler = h;
}

// Per-root handlers for multi-session (conductor tab) mode: each mounted
// session registers under its workspace root, and a request carrying that root
// is routed to it. Requests with no root (or an unknown one) fall back to the
// single global handler.
const rootHandlers = new Map<string, Handler>();
export function registerPermissionHandler(root: string, h: Handler | null): void {
  if (h) rootHandlers.set(root, h);
  else rootHandlers.delete(root);
}

/**
 * Enable or disable yolo mode (auto-approve all future requests).
 * Called by the /yolo command and the --yolo CLI flag.
 */
export function setYolo(on: boolean): void {
  yolo = on;
}

/** Returns true if yolo mode is currently active. */
export function isYolo(): boolean {
  return yolo;
}

/**
 * Reset all session grants and yolo back to defaults.
 * Useful in tests to restore a clean permission state between cases.
 */
export function resetPermissions(): void {
  granted.clear();
  yolo = false;
}

/**
 * Request permission to perform a mutating action. Returns true if the action
 * may proceed, false if it was denied.
 *
 * Fast-path order (no prompt shown):
 *   1. yolo is true  - unconditionally approved.
 *   2. kind is in the standing `granted` set  - approved without a prompt.
 *   3. No handler is installed  - approved (headless / test mode), EXCEPT
 *      forceAsk requests, which deny: an escalation with nobody to ask is not
 *      an approval.
 *
 * Otherwise the handler is called and blocks until the user responds. The
 * resulting decision is applied to the broker state before returning.
 */
export async function requestPermission(req: PermRequest): Promise<boolean> {
  try { ((req.root ? rootPreMutation.get(req.root) : undefined) ?? preMutation)?.(req); } catch { /* the checkpoint hook must never wedge the gate */ }
  // Project rules (.gearbox/permissions.json) pre-decide first: an explicit
  // "deny" refuses even under yolo (the user wrote it down — "rm *": "deny"
  // must hold precisely when everything else is auto-approved), "allow" skips
  // the prompt, "ask" forces one. Unmatched falls through to the broker.
  const rule = ruleFor(loadPermissionRules(), req.kind, req.detail);
  if (rule === "deny") return false;
  if (!req.forceAsk) {
    if (yolo) return true;
    if (rule === "allow") return true;
    if (granted.has(req.kind) && rule !== "ask") return true;
  }
  const route = (req.root && rootHandlers.get(req.root)) || handler;
  // forceAsk exists so escalations (e.g. dropping the sandbox) stay a
  // deliberate HUMAN decision: with no handler to ask (headless), deny —
  // falling through to the allow default would hand out exactly the
  // auto-approval forceAsk is meant to block.
  if (!route) return !req.forceAsk;
  // A plugin can resolve the request programmatically (permission.ask hook) —
  // but never a forceAsk escalation it didn't opt into knowing about: a plugin
  // that auto-allows "shell" must not silently approve sandbox escapes.
  if (!req.forceAsk) {
    try {
      const hook = await emitHook("permission.ask", { kind: req.kind, title: req.title, detail: req.detail });
      if (hook?.decision === "allow") return true;
      if (hook?.decision === "deny") return false;
    } catch { /* a plugin must never wedge the gate */ }
  }
  const decision = await route(req);
  if (decision === "all") {
    yolo = true;
    return true;
  }
  if (decision === "always") {
    granted.add(req.kind);
    return true;
  }
  return decision === "once";
}
