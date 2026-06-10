// Conductor: parallel sessions as tabs in one TUI. Each tab is a fully
// independent App instance bound to its own workspace (a git worktree under
// .gearbox/tabs/<name> with branch tab/<name>), all mounted simultaneously —
// background sessions keep streaming, running tools, and verifying while you
// look at another tab. Only the ACTIVE tab is visible (display:none) and only
// it receives keyboard/mouse input; cross-session safety comes from the
// per-root seams: permission prompts route to the owning tab
// (registerPermissionHandler), turn checkpoints snapshot the owning tree
// (registerPreMutationHook), and every turn captures its tab's root for tools,
// context, and session persistence. The tab bar costs no screen row — it rides
// the masthead next to the wordmark as CLICKABLE cells (click a tab to switch,
// click + for a new session; ⚠ = a hidden tab waits on a permission prompt).
import React, { useCallback, useMemo, useRef, useState } from "react";
import { Box } from "ink";
import { basename, join } from "node:path";
import { App, type AppProps, type SessionStatus, type TabControl } from "../App.tsx";
import type { TabRow } from "../tabbar.ts";
import type { ModelSelector } from "../../model/selector.ts";
import { repoRoot, worktreeAdd } from "../../git/ops.ts";

export interface ConductorProps {
  selector: ModelSelector; // tab 1's selector (from the CLI flags)
  makeSelector: () => ModelSelector; // fresh selector per new tab
  fullscreen: boolean;
  resumeId?: string; // --continue applies to tab 1 only
}

interface TabState {
  id: number;
  dir: string;
  selector: ModelSelector;
  resumeId?: string;
  status: SessionStatus;
}

/** Pure: the masthead tab-bar rows for a tab set (always shown, even with one
 *  tab — the + cell is how parallel sessions are discovered). */
export function tabRowsOf(tabs: { dir: string; status: SessionStatus }[], activeIdx: number): TabRow[] {
  return tabs.map((t, i) => ({
    title: t.status.title || basename(t.dir),
    active: i === activeIdx,
    busy: t.status.busy,
    needsInput: t.status.needsInput,
  }));
}

/** Pure: a filesystem/branch-safe tab slug. */
export function tabSlug(name: string | undefined, id: number): string {
  const base = (name ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return base || `tab-${id}`;
}

let nextTabId = 2; // tab 1 is the launch session

export function Conductor({ selector, makeSelector, fullscreen, resumeId }: ConductorProps) {
  const idleStatus = (dir: string): SessionStatus => ({ busy: false, needsInput: false, title: basename(dir) });
  const [tabs, setTabs] = useState<TabState[]>(() => [
    { id: 1, dir: process.cwd(), selector, resumeId, status: idleStatus(process.cwd()) },
  ]);
  const [activeIdx, setActiveIdx] = useState(0);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeIdxRef = useRef(activeIdx);
  activeIdxRef.current = activeIdx;

  // Per-tab notices that must surface inside the ACTIVE session would need a
  // channel back into App; v1 keeps conductor feedback in the strip itself.

  const switchTo = useCallback((n: number) => {
    const list = tabsRef.current;
    const idx = Math.min(Math.max(0, n - 1), list.length - 1);
    if (idx === activeIdxRef.current) return;
    // The process-global cwd follows the active tab (status line, !cmd, git
    // suite). Background turns are immune: they captured their root at start.
    try { process.chdir(list[idx]!.dir); } catch { /* dir vanished: stay put visually anyway */ }
    setActiveIdx(idx);
  }, []);

  const create = useCallback((name?: string) => {
    const id = nextTabId++;
    const slug = tabSlug(name, id);
    const root = repoRoot(process.cwd());
    let dir = process.cwd();
    if (root) {
      // One worktree per tab so parallel sessions never stomp each other's
      // files. Branch tab/<slug> from the current HEAD; the user merges (or
      // discards) with the normal git suite when the tab's work is done.
      const wtDir = join(root, ".gearbox", "tabs", slug);
      const r = worktreeAdd(wtDir, `tab/${slug}`, root);
      if (r.ok) dir = wtDir;
      // Not a repo / worktree failed → same-dir tab (sessions share files; the
      // permission/checkpoint seams still key on the shared root correctly).
    }
    const tab: TabState = { id, dir, selector: makeSelector(), status: idleStatus(dir) };
    setTabs((t) => [...t, tab]);
    try { process.chdir(dir); } catch { /* keep going; the App pins its own root */ }
    setActiveIdx(tabsRef.current.length); // the new tab lands at the end
  }, [makeSelector]);

  const close = useCallback(() => {
    const list = tabsRef.current;
    if (list.length < 2) return; // the last session closes by quitting gearbox
    const idx = activeIdxRef.current;
    if (list[idx]!.status.busy) return; // never kill a running turn silently
    // The worktree is deliberately left on disk: closing a tab must never be
    // the thing that destroys work. /worktree rm cleans up explicitly.
    const next = list.filter((_, i) => i !== idx);
    const nextIdx = Math.min(idx, next.length - 1);
    try { process.chdir(next[nextIdx]!.dir); } catch { /* best-effort */ }
    setTabs(next);
    setActiveIdx(nextIdx);
  }, []);

  const cycle = useCallback((delta: number) => {
    const len = tabsRef.current.length;
    if (len < 2) return;
    switchTo(((activeIdxRef.current + delta + len) % len) + 1);
  }, [switchTo]);

  // ONE stable control object: it reads refs, so handleCommand's useCallback
  // can hold it without staleness and without re-creating per render.
  const control = useMemo<TabControl>(() => ({
    create,
    close,
    switchTo,
    cycle,
    list: () =>
      tabsRef.current.map((t, i) => ({
        title: t.status.title || basename(t.dir),
        dir: t.dir,
        active: i === activeIdxRef.current,
        status: t.status.needsInput ? "needs input" : t.status.busy ? "working" : "idle",
      })),
  }), [create, close, switchTo, cycle]);

  const onStatusFor = useCallback((id: number) => (s: SessionStatus) => {
    setTabs((t) => t.map((tab) => (tab.id === id ? { ...tab, status: s } : tab)));
  }, []);
  // Stable per-tab callbacks (a fresh closure per render would re-fire App's
  // onStatus effect every frame).
  const statusCbs = useRef(new Map<number, (s: SessionStatus) => void>());
  const statusCb = (id: number) => {
    let cb = statusCbs.current.get(id);
    if (!cb) { cb = onStatusFor(id); statusCbs.current.set(id, cb); }
    return cb;
  };

  const rows = tabRowsOf(tabs, activeIdx);
  return (
    <>
      {tabs.map((t, i) => (
        <Box key={t.id} display={i === activeIdx ? "flex" : "none"} flexDirection="column">
          <App
            selector={t.selector}
            fullscreen={fullscreen}
            resumeId={t.resumeId}
            root={t.dir}
            active={i === activeIdx}
            onStatus={statusCb(t.id)}
            tabs={control}
            tabRows={rows}
          />
        </Box>
      ))}
    </>
  );
}

export type { AppProps };
