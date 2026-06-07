// Lightweight connectivity check for the status bar. We can't ask the OS "is
// wifi on?" portably, so we probe reachability of a stable host with a short
// timeout. `useOnline` polls in the background and exposes a boolean; the status
// bar shows "⚠ offline" when it goes false. Cheap HEAD-ish GET, no payload.
import { useEffect, useRef, useState } from "react";

// A few well-known, fast, CORS-free hosts. Any one succeeding = online.
const PROBES = ["https://www.gstatic.com/generate_204", "https://api.anthropic.com/", "https://1.1.1.1/"];

export async function probeOnline(timeoutMs = 3500): Promise<boolean> {
  for (const url of PROBES) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      // `no-cors` style: even an opaque/!ok response proves the network is up;
      // only a thrown error (DNS/connect failure) means offline.
      await fetch(url, { method: "GET", signal: ctrl.signal });
      clearTimeout(t);
      return true;
    } catch {
      /* try the next probe */
    }
  }
  return false;
}

/** True/false online state, re-checked every `intervalMs`. Starts optimistic
 *  (true) so we never flash "offline" before the first probe resolves. Pass
 *  `enabled: false` (e.g. tests) to skip probing entirely — no
 *  network calls, always reports online. */
export function useOnline(intervalMs = 20_000, enabled = true): boolean {
  const [online, setOnline] = useState(true);
  const alive = useRef(true);
  useEffect(() => {
    if (!enabled) return;
    alive.current = true;
    const run = async () => {
      const ok = await probeOnline();
      if (alive.current) setOnline(ok);
    };
    void run();
    const id = setInterval(run, intervalMs);
    return () => {
      alive.current = false;
      clearInterval(id);
    };
  }, [intervalMs, enabled]);
  return online;
}

/** Does an error look like a network/offline failure (vs. an API/auth error)? */
export function isNetworkError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e ?? "")).toLowerCase();
  // Includes the undici/AI-SDK shapes the old regex missed: "Connect Timeout Error",
  // "attempted address …:443", and the SDK's "failed after N attempts" retry wrapper.
  return /enotfound|econnrefused|econnreset|etimedout|eai_again|network|fetch failed|failed to fetch|socket hang up|getaddrinfo|dns|connect timeout|timeouterror|undici|attempted address|und_err|failed after \d+ attempt|connection (?:reset|closed|refused|error|timed out)|timed? ?out/.test(msg);
}
