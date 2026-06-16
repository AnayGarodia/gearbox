import { useCallback, useEffect, useState } from "react";
import { listAccounts } from "../accounts/store.ts";
import { recordRateLimits } from "../accounts/usage.ts";
import { probeUsage } from "../accounts/usage-probe.ts";
import type { Account } from "../accounts/types.ts";

/** Live subscription-usage probing for CLI accounts. Reads exact 5h/7d limits
 *  WITHOUT touching any vendor token: Codex from the rollout it already writes
 *  (free), Claude via a tiny statusLine probe (one cheap turn). All best-effort
 *  — on any failure callers fall back to stream data.
 *
 *  Owns the `probing` set (account ids with a probe in flight, shown as
 *  "checking…"). `bumpUsage` is passed in because the usage-tick reducer also
 *  fires on spend changes elsewhere in the turn loop, so it stays in App.
 *
 *  - A periodic probe runs ONLY while the usage strip is pinned: the active
 *    account immediately on open and on every switch, Codex every 90s, Claude
 *    every 10m.
 *  - `probeAccountUsage` is a one-shot callable from boot and the `/usage`
 *    command so real numbers appear without pinning. */
export function useUsageProbe(opts: {
  statusPinned: boolean;
  activeCliId: string | undefined;
  bumpUsage: () => void;
}): { probing: Set<string>; probeAccountUsage: (a: Account | undefined) => Promise<void> } {
  const { statusPinned, activeCliId, bumpUsage } = opts;
  const [probing, setProbing] = useState<Set<string>>(new Set());

  const probeAccountUsage = useCallback(async (a: Account | undefined) => {
    if (!a || a.exec !== "cli" || a.auth.kind !== "cli") return;
    setProbing((p) => { const n = new Set(p); n.add(a.id); return n; });
    try {
      const snaps = await probeUsage(a);
      if (snaps?.length) { recordRateLimits(a.id, snaps, { replace: true }); bumpUsage(); }
    } catch { /* best-effort; fall back to stream data */ }
    finally { setProbing((p) => { const n = new Set(p); n.delete(a.id); return n; }); }
  }, [bumpUsage]);

  // Periodic probe — only while the usage strip is pinned.
  useEffect(() => {
    if (!statusPinned) return;
    let alive = true;
    const subs = () => listAccounts().filter((a) => a.enabled && a.exec === "cli" && a.auth.kind === "cli");
    const probeOne = async (a: Account | undefined) => {
      if (!a || !alive) return;
      setProbing((p) => { const n = new Set(p); n.add(a.id); return n; });
      try {
        const snaps = await probeUsage(a);
        // replace: the probe is a complete snapshot → drop windows it no longer
        // reports (e.g. a stale 7-day on a Pro plan) instead of leaving them ghosted.
        if (snaps?.length && alive) { recordRateLimits(a.id, snaps, { replace: true }); bumpUsage(); }
      } catch { /* best-effort; fall back to stream data */ }
      finally { if (alive) setProbing((p) => { const n = new Set(p); n.delete(a.id); return n; }); }
    };
    const list = subs();
    const active = list.find((a) => a.id === activeCliId) ?? list[0];
    void probeOne(active); // instant feedback for the visible account
    const codexTimer = setInterval(() => { for (const a of subs()) if (a.auth.kind === "cli" && a.auth.binary.includes("codex")) void probeOne(a); }, 90_000);
    const claudeTimer = setInterval(() => { for (const a of subs()) void probeOne(a); }, 10 * 60_000);
    return () => { alive = false; clearInterval(codexTimer); clearInterval(claudeTimer); };
  }, [statusPinned, activeCliId, bumpUsage]);

  // Probe each subscription once at launch so the FIRST /usage shows real numbers.
  useEffect(() => {
    for (const a of listAccounts().filter((x) => x.enabled && x.exec === "cli" && x.auth.kind === "cli")) void probeAccountUsage(a);
  }, [probeAccountUsage]);

  return { probing, probeAccountUsage };
}
