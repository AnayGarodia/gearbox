// Ephemeral toasts — short confirmations ("theme → gruvbox", "copied") that
// matter for two seconds and then are noise. They render right-aligned above
// the status bar and expire on a timer, so the transcript stays pure
// conversation + work record. Anything the user might want to LOOK UP later
// (commits, errors, account changes) still belongs in the transcript.
export type ToastKind = "ok" | "info" | "err";

export interface Toast {
  id: number;
  text: string;
  kind: ToastKind;
  at: number;
}

export const TOAST_TTL_MS = 2400;
export const MAX_TOASTS = 2;

/** Append a toast, keeping at most MAX_TOASTS (oldest drops first). Pure. */
export function addToast(toasts: Toast[], toast: Toast): Toast[] {
  return [...toasts, toast].slice(-MAX_TOASTS);
}

/** Drop expired toasts. Pure. */
export function pruneToasts(toasts: Toast[], now: number, ttlMs = TOAST_TTL_MS): Toast[] {
  return toasts.filter((t) => now - t.at < ttlMs);
}
