import { useCallback, useEffect, useRef, useState } from "react";
import { addToast, TOAST_TTL_MS, type Toast, type ToastKind } from "./toast.ts";

/** Ephemeral toasts: short confirmations that expire after TOAST_TTL_MS.
 *  Owns the toast list, the id counter, and the per-toast expiry timers
 *  (all cleared on unmount). `toast(text, kind)` is stable across renders so
 *  callers can list it in dependency arrays without re-creating callbacks. */
export function useToasts(): { toasts: Toast[]; toast: (text: string, kind?: ToastKind) => void } {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const toast = useCallback((text: string, kind: ToastKind = "ok") => {
    const id = ++idRef.current;
    setToasts((prev) => addToast(prev, { id, text, kind, at: Date.now() }));
    const t = setTimeout(() => {
      timersRef.current.delete(t);
      setToasts((prev) => prev.filter((x) => x.id !== id));
    }, TOAST_TTL_MS);
    timersRef.current.add(t);
  }, []);

  useEffect(() => () => { for (const t of timersRef.current) clearTimeout(t); }, []);

  return { toasts, toast };
}
