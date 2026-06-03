// Permission broker. Mutating tools (write/edit/shell) call requestPermission()
// and block until the UI resolves it. Three escalating grants:
//   - "always": that KIND is auto-approved for the rest of the session
//   - "all" / YOLO: everything is auto-approved (no more prompts) until toggled off
// "ask" is the default; YOLO is opt-in (the prompt's "allow all", /yolo, or --yolo).
// No handler installed (tests / headless) → allow, so non-interactive use is unchanged.
export type PermKind = "write" | "edit" | "shell";
export interface PermRequest {
  kind: PermKind;
  title: string; // short label, e.g. "Run a shell command"
  detail: string; // the concrete thing: a path, or the command
}
export type PermDecision = "once" | "always" | "all" | "deny";
type Handler = (req: PermRequest) => Promise<PermDecision>;

let handler: Handler | null = null;
const granted = new Set<PermKind>();
let yolo = false;

export function setPermissionHandler(h: Handler | null): void {
  handler = h;
}
export function setYolo(on: boolean): void {
  yolo = on;
}
export function isYolo(): boolean {
  return yolo;
}
export function resetPermissions(): void {
  granted.clear();
  yolo = false;
}

/** True if the action may proceed. YOLO and per-kind "always" skip the prompt. */
export async function requestPermission(req: PermRequest): Promise<boolean> {
  if (yolo) return true;
  if (granted.has(req.kind)) return true;
  if (!handler) return true;
  const decision = await handler(req);
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
