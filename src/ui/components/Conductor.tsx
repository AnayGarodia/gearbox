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
import { existsSync } from "node:fs";
import { App, type AppProps, type ForkPayload, type SessionStatus, type TabControl } from "../App.tsx";
import { newSessionId, saveSession, type Session } from "../../session.ts";
import { lookForTabName } from "./Mascot.tsx";
import { nextTabName, TAB_NAMES, type TabRow } from "../tabbar.ts";
import type { ModelSelector } from "../../model/selector.ts";
import { ensureExcluded, repoRoot, worktreeAdd } from "../../git/ops.ts";
import { hasSetup, runSetup } from "../../setup.ts";

export interface ConductorProps {
  selector: ModelSelector; // tab 1's selector (from the CLI flags)
  makeSelector: () => ModelSelector; // fresh selector per new tab
  fullscreen: boolean;
  resumeId?: string; // --continue applies to tab 1 only
}

interface TabState {
  id: number;
  /** The tab's own name (slug / wardrobe pick). The display fallback when the
   *  session has no title yet — NOT basename(dir): a same-dir tab (launch dir
   *  not a repo → no worktree) would otherwise show the launch folder's name
   *  on every tab ("Desktop", "Desktop", …). */
  name: string;
  dir: string;
  selector: ModelSelector;
  resumeId?: string;
  initialPrompt?: string;
  status: SessionStatus;
  /** finished a turn while hidden, not yet visited — the cell shows ✓ green */
  unseen?: boolean;
  /** this tab's `.gearbox/setup` is bootstrapping its worktree (⟳) or failed (✗) */
  setup?: "running" | "failed";
  /** one-shot setup result to surface inside this tab's session (see App.setupNote) */
  setupNote?: string;
}

/** Pure: the masthead tab-bar rows for a tab set (always shown, even with one
 *  tab — the + cell is how parallel sessions are discovered). */
export function tabRowsOf(tabs: { dir: string; name?: string; status: SessionStatus; unseen?: boolean; setup?: "running" | "failed" }[], activeIdx: number): TabRow[] {
  const baseDir = tabs[0]?.dir;
  return tabs.map((t, i) => ({
    title: t.name || t.status.title || basename(t.dir), // a NAMED tab keeps its name; auto-title only fills unnamed ones
    active: i === activeIdx,
    busy: t.status.busy,
    needsInput: t.status.needsInput,
    done: !!t.unseen && i !== activeIdx,
    setup: t.setup,
    // A non-base tab with its OWN worktree can be landed into the base (tab 1).
    // A same-dir tab (no worktree → shares tab 1's files) has nothing to merge.
    mergeable: i > 0 && t.dir !== baseDir,
  }));
}

/** Last few lines of setup output, clipped — enough to see the failure.
 *  Falls back to a marker when nothing was captured, so the failure note is
 *  never a bare "failed —" with no detail. */
function setupTail(output: string): string {
  const lines = output.split("\n").map((l) => l.trimEnd()).filter(Boolean);
  const tail = lines.slice(-6).join("\n").slice(0, 600);
  return tail || "(no output captured)";
}

/** Best-effort human string for a thrown value — an Error's message, a plain
 *  string, else JSON so a `{ code }` object never renders as "[object Object]". */
function errText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === "string") return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}

/** Pure: a filesystem/branch-safe tab slug. */
export function tabSlug(name: string | undefined, id: number): string {
  const base = (name ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return base || `tab-${id}`;
}

let nextTabId = 2; // tab 1 is the launch session

export function Conductor({ selector, makeSelector, fullscreen, resumeId }: ConductorProps) {
  // title stays EMPTY until the session earns one (first turn's auto-title):
  // the tab's own `name` is the display fallback, never the directory.
  const idleStatus = (_dir: string): SessionStatus => ({ busy: false, needsInput: false, title: "" });
  // ONE state object for {tabs, active}: a tab create/switch/close must be a
  // SINGLE setState. Two separate states rendered an intermediate frame when
  // called from the raw mouse handler (no React event batching there), and
  // that extra frame scrolled the alt screen by one row — permanently shifting
  // the whole UI off its mouse maps.
  const [tabState, setTabState] = useState<{ tabs: TabState[]; active: number }>(() => ({
    tabs: [{ id: 1, name: basename(process.cwd()), dir: process.cwd(), selector, resumeId, status: idleStatus(process.cwd()) }],
    active: 0,
  }));
  const tabs = tabState.tabs;
  const activeIdx = tabState.active;
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
    // Visiting a tab acknowledges its ✓ (the green cell is the notification).
    // ONE setState: tabs + active move together (no intermediate frame).
    setTabState((s) => ({
      tabs: s.tabs.map((tab, i) => (i === idx && tab.unseen ? { ...tab, unseen: false } : tab)),
      active: idx,
    }));
  }, []);

  // The LAUNCH repo root, fixed at mount: new tab worktrees always nest under
  // it. Deriving it from process.cwd() at create time nested worktrees inside
  // worktrees (cwd follows the active tab — creating tab 3 from tab 2 put it
  // at <wizard-worktree>/.gearbox/tabs/skater).
  const homeRootRef = useRef<string | null | undefined>(undefined);
  if (homeRootRef.current === undefined) homeRootRef.current = repoRoot(process.cwd());

  const create = useCallback((name?: string, opts?: { task?: string; fork?: ForkPayload }) => {
    const id = nextTabId++;
    const home = homeRootRef.current ?? null;
    // No name given → dress the tab from Boo's wardrobe (wizard, skater, mint…)
    // instead of "tab-2". A name is taken if an open tab uses it OR its worktree
    // dir already exists on disk (reattaching to old work should be a choice —
    // `/tab new wizard` — not a surprise).
    const taken = new Set(tabsRef.current.map((t) => t.name.toLowerCase()));
    const onDisk = (n: string) => !!home && existsSync(join(home, ".gearbox", "tabs", n));
    let slug: string;
    if (name) slug = tabSlug(name, id);
    else if (opts?.fork) {
      // An unnamed fork is named after its source: wizard → wizard-fork
      // (→ wizard-fork-2 …) — visibly related, never identical.
      const base = tabsRef.current[activeIdxRef.current]?.name ?? "fork";
      let cand = `${base}-fork`;
      for (let k = 2; taken.has(cand.toLowerCase()) || onDisk(cand); k++) cand = `${base}-fork-${k}`;
      slug = tabSlug(cand, id);
    } else {
      slug = nextTabName([...taken, ...TAB_NAMES.filter(onDisk)], id);
    }
    const root = home;
    let dir = process.cwd();
    if (root) {
      // One worktree per tab so parallel sessions never stomp each other's
      // files. Branch tab/<slug> from the current HEAD; the user merges (or
      // discards) with the normal git suite when the tab's work is done.
      const wtDir = join(root, ".gearbox", "tabs", slug);
      // Repo-local ignore for the nest dir (info/exclude, shared by all
      // worktrees): without it, a repo that doesn't ignore .gearbox/ lets the
      // base tab's `git add -A` / checkpoints sweep the nested worktrees.
      ensureExcluded(".gearbox/tabs/", root); // tabs ONLY — .gearbox/ also holds committable project config (permissions.json, mcp.json, plugins/)
      const r = worktreeAdd(wtDir, `tab/${slug}`, root);
      if (r.ok) dir = wtDir;
      // Closing a tab never deletes its worktree, so a reused name finds the
      // dir already on disk and `worktree add` refuses — REATTACH to it rather
      // than silently falling back to a same-dir tab (which would share files
      // with tab 1 when the user explicitly asked for isolation).
      else if (existsSync(join(wtDir, ".git"))) dir = wtDir;
      // Not a repo / worktree failed → same-dir tab (sessions share files; the
      // permission/checkpoint seams still key on the shared root correctly).
    }
    // Fork: snapshot the source conversation as a session under the NEW tab's
    // slug, then let the new App resume it — the fork continues with the full
    // history (and the routing/cost records) in its own worktree.
    let resumeId: string | undefined;
    if (opts?.fork) {
      const snap: Session = {
        id: newSessionId(),
        cwd: dir,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        title: opts.fork.title,
        messages: opts.fork.messages as Session["messages"],
        items: opts.fork.items as Session["items"],
        turns: opts.fork.turns as Session["turns"],
      };
      saveSession(snap, dir);
      resumeId = snap.id;
    }
    // Bootstrap the worktree in the BACKGROUND when the tab got its own tree and
    // the repo defines `.gearbox/setup` (install deps, codegen). Never blocks the
    // tab: the cell shows ⟳ until it settles, then clears (or ✗ on failure with a
    // note surfaced inside the session).
    const isolated = !!root && dir.startsWith(join(root, ".gearbox", "tabs"));
    const willSetup = isolated && !!root && hasSetup(root);
    const tab: TabState = { id, name: slug, dir, selector: makeSelector(), resumeId, initialPrompt: opts?.task, status: idleStatus(dir), setup: willSetup ? "running" : undefined };
    try { process.chdir(dir); } catch { /* keep going; the App pins its own root */ }
    setTabState((s) => ({ tabs: [...s.tabs, tab], active: s.tabs.length })); // the new tab lands at the end
    if (willSetup) {
      void runSetup(dir)
        .then((res) => finishSetup(id, res.ok, res.ok ? "" : setupTail(res.output)))
        .catch((e: unknown) => finishSetup(id, false, setupTail(errText(e))));
    }
  }, [makeSelector]);

  // Settle a tab's background setup: clear the ⟳ (or mark ✗) and hand the active
  // session a one-shot note. Looked up by id — the tab may have moved/closed.
  const finishSetup = useCallback((id: number, ok: boolean, errTail: string) => {
    setTabState((s) => ({
      ...s,
      tabs: s.tabs.map((t) =>
        t.id !== id ? t : {
          ...t,
          setup: ok ? undefined : "failed",
          setupNote: ok
            ? "✓ worktree ready — .gearbox/setup finished"
            : `⚠ .gearbox/setup failed — this tab's worktree may be missing dependencies:\n${errTail}`,
        },
      ),
    }));
  }, []);

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
    setTabState({ tabs: next, active: nextIdx });
  }, []);

  const cycle = useCallback((delta: number) => {
    const len = tabsRef.current.length;
    if (len < 2) return;
    switchTo(((activeIdxRef.current + delta + len) % len) + 1);
  }, [switchTo]);

  // Close the tab whose worktree is `dir`, keeping whatever tab is active still
  // active (used to archive a merged tab — the worktree was just removed, so the
  // tab must go too). No-op for the last tab, a busy tab, or an unknown dir.
  // Returns true when the tab was found and removed, false when it couldn't be
  // (only tab left, mid-turn, or already gone) so callers don't claim a tab was
  // archived when it is still mounted.
  const closeDir = useCallback((dir: string): boolean => {
    const list = tabsRef.current;
    if (list.length < 2) return false;
    const idx = list.findIndex((t) => t.dir === dir);
    if (idx < 0 || list[idx]!.status.busy) return false;
    const wasActive = idx === activeIdxRef.current;
    const curDir = list[activeIdxRef.current]?.dir;
    const next = list.filter((_, i) => i !== idx);
    // Archiving the active tab (the merge case) falls back to the base (tab 0);
    // otherwise the currently-active tab stays active at its new index.
    const nextActive = wasActive ? 0 : Math.max(0, next.findIndex((t) => t.dir === curDir));
    try { process.chdir(next[nextActive]!.dir); } catch { /* best-effort */ }
    setTabState({ tabs: next, active: nextActive });
    return true;
  }, []);

  // ONE stable control object: it reads refs, so handleCommand's useCallback
  // can hold it without staleness and without re-creating per render.
  const control = useMemo<TabControl>(() => ({
    create,
    close,
    closeDir,
    switchTo,
    cycle,
    list: () =>
      tabsRef.current.map((t, i) => ({
        title: t.name || t.status.title,
        dir: t.dir,
        active: i === activeIdxRef.current,
        status: t.status.needsInput ? "needs input" : t.status.busy ? "working" : "idle",
      })),
  }), [create, close, closeDir, switchTo, cycle]);

  const onStatusFor = useCallback((id: number) => (st: SessionStatus) => {
    setTabState((s) => ({
      ...s,
      tabs: s.tabs.map((tab, i) => {
        if (tab.id !== id) return tab;
        // busy → idle while HIDDEN marks the cell ✓-unseen (cleared on visit).
        const finishedHidden = tab.status.busy && !st.busy && i !== s.active;
        return { ...tab, status: st, unseen: finishedHidden ? true : tab.unseen };
      }),
    }));
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
            initialPrompt={t.initialPrompt}
            ghostLook={i === 0 ? undefined : lookForTabName(t.name) ?? undefined}
            setupNote={t.setupNote}
          />
        </Box>
      ))}
    </>
  );
}

export type { AppProps };
