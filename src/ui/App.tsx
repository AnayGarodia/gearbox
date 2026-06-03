import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdin } from "ink";
import type { ModelMessage } from "ai";
import { Banner } from "./components/Banner.tsx";
import { Transcript } from "./components/Transcript.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { FilePalette } from "./components/FilePalette.tsx";
import { Composer } from "./components/Composer.tsx";
import { MascotSplash, SKINS, STATE_GHOST_ROWS, type GhostSkin, type MascotState } from "./components/Mascot.tsx";
import { PermissionPrompt } from "./components/PermissionPrompt.tsx";
import { Working } from "./components/Working.tsx";
import { Viewport } from "./components/Viewport.tsx";
import { itemsToLines } from "./lines.ts";
import { setPermissionHandler, setYolo, isYolo, type PermRequest, type PermDecision } from "../permission.ts";
import { newSessionId, saveSession, loadSession, listSessions, loadHistory, appendHistory, type Session, type TurnMeta } from "../session.ts";
import { nextVerb } from "./character.ts";
import { color, glyph } from "./theme.ts";
import type { Item } from "./types.ts";
import type { OnEvent, Usage } from "../agent/events.ts";
import { FixedSelector, type ModelSelector } from "../model/selector.ts";
import { RoutingSelector } from "../model/router.ts";
import { findModel, type ModelSpec } from "../providers.ts";
import { runTask } from "../agent/run.ts";
import { buildContext, sanitizeToolPairs } from "../context/builder.ts";
import { compactHistory, modelSummarizer, estimateHistoryTokens } from "../context/compact.ts";
import { appendFact, loadFacts } from "../context/memory.ts";
import { runTaskMock } from "../agent/mock.ts";
import { runShell } from "../shell.ts";
import { helpText, formatModelList, resolveModelSwitch, matchCommands, formatContextBreakdown } from "../commands.ts";
import { applyKey, type Edit } from "./input.ts";
import { navHistory } from "./history.ts";
import { currentMention, matchFiles, completeMention } from "./mention.ts";
import { listProjectFiles, expandMentions } from "./files.ts";
import { useTerminalSize } from "./useTerminalSize.ts";
import { gitBranch } from "./git.ts";
import { basename } from "node:path";

export type Runner = (opts: {
  prompt: string;
  messages: ModelMessage[];
  onEvent: OnEvent;
  selector: ModelSelector;
  signal: AbortSignal;
}) => Promise<{ messages: ModelMessage[]; usage: Usage }>;

export interface AppProps {
  selector: ModelSelector;
  demo: boolean;
  runner?: Runner;
  fullscreen?: boolean;
  resumeId?: string; // resume this saved session on launch (--continue)
}

export function App({ selector: initialSelector, demo, runner, fullscreen = false, resumeId }: AppProps) {
  const { exit } = useApp();
  const { stdin, isRawModeSupported } = useStdin();
  const { columns, rows } = useTerminalSize();
  // Chrome (title bar, rules, composer, status) spans the full terminal width;
  // long prose wraps at a readable cap inside it (see Transcript).
  const width = columns;
  // Splash art scales to the window so small/short terminals never overflow:
  // full ghost when roomy, the mini when short, wordmark-only when tiny.
  // The 2× splash ghost is 40 cols × 20 rows; the 1× mini is 20 × 10. Gate so
  // neither overflows a short/narrow window (wordmark-only when tiny).
  const splashSize =
    rows >= 24 && columns >= 42 ? "big" : rows >= 13 && columns >= 22 ? "mini" : "none";

  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusyState] = useState(false);
  const [tokens, setTokens] = useState(0);
  const [lastInput, setLastInput] = useState(0);
  const [edit, setEditState] = useState<Edit>({ value: "", cursor: 0 });
  const [selector, setSelector] = useState<ModelSelector>(initialSelector);
  const [mode, setMode] = useState<"normal" | "plan">("normal");
  const [elapsed, setElapsed] = useState(0);
  const [verb, setVerb] = useState("Spinning up");
  const [ghostSkin, setGhostSkinState] = useState<GhostSkin>("base");
  // The in-flow ghost's face follows the agent's state. `linger` keeps the
  // working line up briefly after a turn for the celebrate/error beat.
  const [mascotState, setMascotState] = useState<MascotState>("thinking");
  const [linger, setLinger] = useState(false);
  const lingerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [yolo, setYoloState] = useState(isYolo());
  const [perm, setPermState] = useState<PermRequest | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const atBottomRef = useRef(true); // follow the live tail unless the user scrolled up

  // live "working · Ns" timer so the harness visibly stays alive
  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    const start = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 500);
    return () => clearInterval(t);
  }, [busy]);

  // Refs read by the (closure-captured) input handler — avoids stale state.
  const editRef = useRef(edit);
  const busyRef = useRef(busy);
  const selectorRef = useRef(selector);
  const modeRef = useRef(mode);
  busyRef.current = busy;
  selectorRef.current = selector;
  modeRef.current = mode;
  const idRef = useRef(0);
  const msgRef = useRef<ModelMessage[]>([]);
  const itemsRef = useRef<Item[]>([]);
  itemsRef.current = items;
  const sessionRef = useRef<{ id: string; createdAt: number; title: string; turns: TurnMeta[] }>({
    id: newSessionId(),
    createdAt: Date.now(),
    title: "",
    turns: [],
  });
  const resumeListRef = useRef<Session[]>([]);
  const curAsstRef = useRef<number | null>(null);
  const historyRef = useRef<string[]>([]);
  const histIdxRef = useRef<number | null>(null);
  const lastPromptRef = useRef<string | null>(null);
  const routedRef = useRef<{ model: ModelSpec; reason: string } | null>(null); // the real per-turn pick
  const abortRef = useRef<AbortController | null>(null);
  const interruptedRef = useRef(false);
  const ghostSkinRef = useRef<GhostSkin>("base");
  const permRef = useRef<PermRequest | null>(null);
  const permQueue = useRef<{ req: PermRequest; resolve: (d: PermDecision) => void }[]>([]);
  const scrollTopRef = useRef(0);
  const viewportHeightRef = useRef(1);
  const maxScrollRef = useRef(0);

  const setPerm = (p: PermRequest | null) => {
    permRef.current = p;
    setPermState(p);
  };
  // Show the next queued permission request (one at a time).
  const pumpPerm = () => {
    if (permRef.current) return;
    const next = permQueue.current[0];
    setPerm(next ? next.req : null);
  };
  const resolvePerm = (d: PermDecision) => {
    const item = permQueue.current.shift();
    setPerm(null);
    if (d === "all") setYoloState(true); // keep the status badge in sync
    item?.resolve(d);
    setTimeout(pumpPerm, 0);
  };

  // Mutating tools (write/edit/shell) block on this; the UI resolves it.
  useEffect(() => {
    setPermissionHandler(
      (req) =>
        new Promise<PermDecision>((resolve) => {
          permQueue.current.push({ req, resolve });
          pumpPerm();
        }),
    );
    return () => setPermissionHandler(null);
  }, []);

  // Scroll the transcript by `delta` lines; re-pin to the bottom when we reach it.
  const scrollBy = useCallback((delta: number) => {
    const cur = atBottomRef.current ? maxScrollRef.current : scrollTopRef.current;
    const ns = Math.max(0, Math.min(maxScrollRef.current, cur + delta));
    atBottomRef.current = ns >= maxScrollRef.current;
    setScrollTop(ns);
  }, []);

  // Mouse-wheel scrolling (SGR mouse reports; button 64 = up, 65 = down). Parsed
  // off raw stdin so it works even though Ink doesn't model mouse events.
  useEffect(() => {
    if (!stdin) return;
    const onData = (d: Buffer | string) => {
      const s = d.toString();
      let delta = 0;
      const re = /\[<(\d+);\d+;\d+[Mm]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(s))) {
        const b = Number(m[1]);
        if (b === 64) delta -= 3;
        else if (b === 65) delta += 3;
      }
      if (delta) scrollBy(delta);
    };
    stdin.on("data", onData);
    return () => {
      stdin.off?.("data", onData);
    };
  }, [stdin, scrollBy]);

  // Save the current conversation (best-effort) — model-agnostic messages + the UI
  // transcript + per-turn model/usage, so it resumes faithfully and feeds routing.
  const persist = useCallback(() => {
    if (demo) return;
    const s = sessionRef.current;
    if (!itemsRef.current.length) return;
    saveSession({
      id: s.id,
      cwd: process.cwd(),
      createdAt: s.createdAt,
      updatedAt: Date.now(),
      title: s.title,
      messages: msgRef.current,
      items: itemsRef.current,
      turns: s.turns,
    });
  }, [demo]);

  const loadInto = (s: Session) => {
    idRef.current = s.items.reduce((m, i) => Math.max(m, i.id), 0) + 1;
    setItems(s.items);
    msgRef.current = s.messages;
    sessionRef.current = { id: s.id, createdAt: s.createdAt, title: s.title, turns: s.turns ?? [] };
    notice(`resumed · ${s.items.length} messages · ${new Date(s.updatedAt).toLocaleString()}`);
  };

  // On launch: load persisted prompt history; resume a session if asked (--continue).
  useEffect(() => {
    const h = loadHistory();
    if (h.length) historyRef.current = h;
    if (resumeId) {
      const s = loadSession(resumeId);
      if (s) loadInto(s);
    }
  }, []);

  const setGhostSkin = (s: GhostSkin) => {
    ghostSkinRef.current = s;
    setGhostSkinState(s);
  };

  const setEdit = (e: Edit) => {
    editRef.current = e;
    setEditState(e);
  };
  const setBusy = (b: boolean) => {
    busyRef.current = b;
    setBusyState(b);
  };

  const branch = useMemo(() => gitBranch(), []);
  const choice = useMemo(() => {
    try {
      return selector.select({ prompt: "" });
    } catch {
      return null;
    }
  }, [selector]);
  // The model + reason that ACTUALLY ran the last turn (routing varies it per
  // task). Falls back to the selector's generic pick before the first turn.
  const [lastPick, setLastPick] = useState<{ model: ModelSpec; reason: string } | null>(null);
  const model = lastPick?.model ?? choice?.model ?? null;
  const modelLabel = demo ? "demo · no key" : (model?.label ?? "none");
  // The routing reason, surfaced in the status line — the product's USP, now the
  // LIVE per-task pick (kind · why · price), not a fixed default.
  const routing = demo ? null : (lastPick?.reason ?? choice?.reason ?? null);
  const ctxPct = model && lastInput > 0 ? Math.round((lastInput / model.contextWindow) * 100) : null;

  const push = (it: Item) => setItems((prev) => [...prev, it]);
  const echo = (text: string) => push({ kind: "user", id: idRef.current++, text });
  const notice = (text: string) => push({ kind: "notice", id: idRef.current++, text });

  const defaultRunner: Runner = useCallback(
    async ({ prompt, messages, onEvent, selector: sel, signal }) => {
      if (demo) return runTaskMock({ prompt, messages, onEvent, signal });
      const plan = modeRef.current === "plan";
      const choice = sel.select({ prompt: prompt, kind: plan ? "plan" : undefined });
      // Record the ACTUAL pick (routing varies it per task) for the status line
      // and the turn ledger — not a re-classification with an empty prompt.
      routedRef.current = { model: choice.model, reason: choice.reason };
      setLastPick({ model: choice.model, reason: choice.reason });
      // The Context Engine projects the full history into a bounded, model-aware
      // working set to SEND; the returned ledger stays the full source of truth.
      const { system, messages: ctx } = buildContext({ history: messages, userText: prompt, model: choice.model, plan });
      const r = await runTask({ model: choice.model, messages: ctx, onEvent, signal, plan, system });
      // r.messages = the sent context + the newly produced turn. Rebuild msgRef as
      // FULL history + the user message + only the new messages (never the curated
      // projection), and sanitize so an interrupted turn can't leave a dangling
      // tool_use that 400s the next request.
      const produced = r.messages.slice(ctx.length);
      const ledger = sanitizeToolPairs([...messages, { role: "user", content: prompt }, ...produced]);
      return { messages: ledger, usage: r.usage };
    },
    [demo],
  );

  // Summarize older turns (cheap model via the selector seam — kind:"summarize")
  // and rewrite msgRef in place. The visible transcript (items) is untouched;
  // only the model's working context shrinks. Returns a status line for a notice.
  const compactNow = useCallback(
    async (keepRecent: number, signal?: AbortSignal): Promise<string> => {
      if (demo) return "compaction needs a model (no key in demo)";
      let model;
      try {
        model = selectorRef.current.select({ prompt: "", kind: "summarize" }).model;
      } catch {
        return "no model available to compact with";
      }
      const res = await compactHistory({ history: msgRef.current, summarize: modelSummarizer(model, signal), keepRecent });
      if (!res) return "nothing old enough to compact yet";
      msgRef.current = res.messages;
      const saved = res.before - res.after;
      const savedStr = saved >= 1000 ? `${(saved / 1000).toFixed(1)}k` : String(Math.max(0, saved));
      return `compacted ${res.summarizedTurns} earlier turn${res.summarizedTurns > 1 ? "s" : ""} · ~${savedStr} tokens freed`;
    },
    [demo],
  );

  const togglePlan = () => {
    const next = modeRef.current === "plan" ? "normal" : "plan";
    modeRef.current = next;
    setMode(next);
    notice(next === "plan" ? "plan mode on — read-only; I'll propose a plan before changing anything" : "plan mode off");
  };

  const runTurn = useCallback(
    async (prompt: string) => {
      echo(prompt);
      lastPromptRef.current = prompt;
      setVerb(nextVerb());
      const { text: modelPrompt, attached } = expandMentions(prompt);
      if (attached.length) notice(`attached ${attached.length} file${attached.length > 1 ? "s" : ""}: ${attached.join(", ")}`);
      setBusy(true);
      if (lingerRef.current) clearTimeout(lingerRef.current);
      setLinger(false);
      setMascotState("thinking");
      atBottomRef.current = true; // follow the live output
      if (!sessionRef.current.title) sessionRef.current.title = prompt.slice(0, 80);
      curAsstRef.current = null;
      const ac = new AbortController();
      abortRef.current = ac;
      const toolMap = new Map<string, number>();
      let hadError = false;

      const onEvent: OnEvent = (e) => {
        if (e.type === "text") {
          setMascotState("streaming");
          if (curAsstRef.current === null) {
            const id = idRef.current++;
            curAsstRef.current = id;
            setItems((prev) => [...prev, { kind: "assistant", id, text: e.text, done: false }]);
          } else {
            const id = curAsstRef.current;
            setItems((prev) => prev.map((i) => (i.id === id && i.kind === "assistant" ? { ...i, text: i.text + e.text } : i)));
          }
        } else if (e.type === "tool-start") {
          setMascotState("tool");
          curAsstRef.current = null;
          const id = idRef.current++;
          toolMap.set(e.id, id);
          setItems((prev) => [...prev, { kind: "tool", id, callId: e.id, name: e.name, arg: e.arg, status: "running", summary: "" }]);
        } else if (e.type === "tool-stream") {
          // The tool's input is streaming in: update the head label and/or append
          // the streamed content (a file being written line by line). Keep only a
          // bounded TAIL of the content — re-splitting a growing 2500-line string
          // every token is O(n²) and freezes the UI (it would look "all at once").
          const id = toolMap.get(e.id);
          setItems((prev) =>
            prev.map((i) => {
              if (i.id !== id || i.kind !== "tool") return i;
              if (e.delta == null) return { ...i, arg: e.arg ?? i.arg };
              const lines = (e.delta.match(/\n/g) || []).length;
              const tail = ((i.stream ?? "") + e.delta).slice(-2000); // ~last 25 lines
              return { ...i, arg: e.arg ?? i.arg, stream: tail, streamCount: (i.streamCount ?? 0) + lines };
            }),
          );
        } else if (e.type === "tool-end") {
          setMascotState("thinking"); // back to reasoning until the next text/tool
          const id = toolMap.get(e.id);
          setItems((prev) => prev.map((i) => (i.id === id && i.kind === "tool" ? { ...i, status: e.ok ? "ok" : "err", summary: e.summary, diff: e.diff, stream: undefined } : i)));
        } else if (e.type === "error") {
          hadError = true;
          setMascotState("error");
          curAsstRef.current = null;
          push({ kind: "error", id: idRef.current++, text: e.message });
        } else if (e.type === "done") {
          if (e.usage.inputTokens > 0) setLastInput(e.usage.inputTokens);
          setTokens((t) => t + e.usage.inputTokens + e.usage.outputTokens);
        }
      };

      try {
        const r = await (runner ?? defaultRunner)({ prompt: modelPrompt, messages: msgRef.current, onEvent, selector: selectorRef.current, signal: ac.signal });
        msgRef.current = r.messages;
        // Record the turn's model + usage (routing/cost data; per-turn so the
        // router can vary the model later without changing this shape).
        // The model that actually ran this turn (set by defaultRunner). Falls
        // back to a fresh select only if a custom runner bypassed defaultRunner.
        let modelId = routedRef.current?.model.id;
        if (!modelId) {
          try {
            modelId = selectorRef.current.select({ prompt: lastPromptRef.current ?? "" }).model.id;
          } catch {
            modelId = "unknown";
          }
        }
        sessionRef.current.turns.push({ model: modelId, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, at: Date.now() });
        // Auto-compact: once the history approaches the budget, summarize old
        // turns (cheap delegated model) so the next turns stay bounded without
        // losing the gist. Best-effort and skipped on interrupt.
        if (!demo && !ac.signal.aborted) {
          try {
            const cm = selectorRef.current.select({ prompt: "", kind: "summarize" }).model;
            const budget = Math.max(8000, cm.contextWindow - 32000);
            // Conservative on purpose: the builder's per-turn elision already
            // keeps normal sessions bounded (old tool output dropped every turn);
            // compaction is the deeper safety net for genuinely long sessions, so
            // it only fires when even the raw ledger nears the budget. Summarizing
            // costs a model call, so we don't do it eagerly.
            const COMPACT_AT = 0.6;
            if (estimateHistoryTokens(msgRef.current, cm.id) > budget * COMPACT_AT) {
              setVerb("Compacting context");
              notice(await compactNow(4, ac.signal));
            }
          } catch {
            /* compaction is best-effort; never fail the turn over it */
          }
        }
      } catch (err: any) {
        if (!ac.signal.aborted) {
          hadError = true;
          onEvent({ type: "error", message: err?.message ?? String(err) });
        }
      } finally {
        abortRef.current = null;
        setBusy(false);
        persist();
        const interrupted = interruptedRef.current;
        if (interrupted) {
          notice("interrupted");
          interruptedRef.current = false;
        }
        // A brief post-turn beat: confetti on a clean finish, crying on an error.
        // The working line lingers ~1.5s (it unmounts the instant busy goes false
        // otherwise, so these states would never render). Skip on a user interrupt.
        if (!interrupted) {
          setMascotState(hadError ? "error" : "celebrate");
          setLinger(true);
          if (lingerRef.current) clearTimeout(lingerRef.current);
          lingerRef.current = setTimeout(() => setLinger(false), 1500);
        }
      }
    },
    [runner, defaultRunner, persist],
  );

  const handleCommand = useCallback(
    (text: string) => {
      const body = text.slice(1);
      const name = (body.split(/\s+/)[0] ?? "").toLowerCase();
      const arg = body.slice(name.length).trim();
      const currentId = (() => {
        try {
          return selectorRef.current.select({ prompt: "" }).model.id;
        } catch {
          return null;
        }
      })();

      switch (name) {
        case "exit":
        case "quit":
          exit();
          return;
        case "clear":
          setItems([]);
          msgRef.current = [];
          itemsRef.current = [];
          setTokens(0);
          setLastInput(0);
          curAsstRef.current = null;
          sessionRef.current = { id: newSessionId(), createdAt: Date.now(), title: "", turns: [] };
          return;
        case "resume": {
          echo(text);
          const sessions = listSessions();
          if (!arg) {
            resumeListRef.current = sessions;
            if (!sessions.length) {
              notice("no saved sessions for this project yet");
              return;
            }
            const rows = sessions
              .slice(0, 10)
              .map((s, i) => `  ${i + 1}. ${new Date(s.updatedAt).toLocaleString()} · ${s.title || "(untitled)"} (${s.items.length} msgs)`)
              .join("\n");
            notice("resume a session — /resume <n>:\n" + rows);
            return;
          }
          const pick = (resumeListRef.current.length ? resumeListRef.current : sessions)[parseInt(arg, 10) - 1];
          if (!pick) {
            notice(`no session ${arg} — /resume to list`);
            return;
          }
          loadInto(pick);
          return;
        }
        case "help":
          echo(text);
          notice(helpText());
          return;
        case "plan":
          echo(text);
          togglePlan();
          return;
        case "yolo": {
          echo(text);
          const next = !isYolo();
          setYolo(next);
          setYoloState(next);
          notice(next ? "yolo mode ON — all file writes and shell commands run without asking" : "yolo mode off — back to asking before writes/edits/shell");
          return;
        }
        case "ghost": {
          echo(text);
          let next: GhostSkin;
          if (arg) {
            const found = SKINS.find((s) => s === arg.toLowerCase());
            if (!found) {
              notice(`unknown mood: ${arg} — try ${SKINS.join(", ")}`);
              return;
            }
            next = found;
          } else {
            next = SKINS[(SKINS.indexOf(ghostSkinRef.current) + 1) % SKINS.length]!;
          }
          setGhostSkin(next);
          notice(`Boo is feeling ${next}.`);
          return;
        }
        case "cwd":
          echo(text);
          notice(process.cwd());
          return;
        case "retry":
          if (!lastPromptRef.current) {
            echo(text);
            notice("nothing to retry yet");
            return;
          }
          void runTurn(lastPromptRef.current);
          return;
        case "model":
          echo(text);
          if (!arg) {
            const mode = selectorRef.current instanceof RoutingSelector ? "auto (routing on) — /model <name> to pin, /model auto to route" : "pinned — /model auto to route per task";
            notice(formatModelList(currentId) + `\n  mode: ${mode}`);
            return;
          }
          if (arg.toLowerCase() === "auto" || arg.toLowerCase() === "route") {
            setSelector(new RoutingSelector());
            setLastPick(null);
            routedRef.current = null;
            notice("routing on — Gearbox picks the model per task (cheapest that clears the bar)");
            return;
          }
          {
            const r = resolveModelSwitch(arg);
            if (r.ok && r.modelId) {
              setSelector(new FixedSelector(r.modelId));
              setLastPick(null);
              routedRef.current = null;
            }
            notice(r.ok ? `${r.message} (pinned — routing off; /model auto to re-enable)` : r.message);
          }
          return;
        case "memory": {
          echo(text);
          if (arg) {
            notice(appendFact(arg) ? "remembered" : "couldn't save that note");
            return;
          }
          const facts = loadFacts().trim();
          notice(facts ? "remembered facts:\n" + facts : "no remembered facts yet — add one with #<note> or /memory <note>");
          return;
        }
        case "context": {
          echo(text);
          const m = (() => { try { return selectorRef.current.select({ prompt: "" }).model; } catch { return null; } })();
          if (!m) {
            notice("no model available — set a key to see the working set");
            return;
          }
          const { sections } = buildContext({ history: msgRef.current, userText: lastPromptRef.current || "(your next message)", model: m, plan: modeRef.current === "plan" });
          notice(formatContextBreakdown(sections, m.contextWindow));
          return;
        }
        case "compact": {
          echo(text);
          if (busyRef.current) {
            notice("busy — try /compact once the current turn finishes");
            return;
          }
          if (demo) {
            notice("compaction needs a model (no key in demo)");
            return;
          }
          setBusy(true);
          setVerb("Compacting context");
          setMascotState("thinking");
          const ac = new AbortController();
          abortRef.current = ac;
          void (async () => {
            try {
              notice(await compactNow(2, ac.signal));
              persist();
            } catch {
              notice("compaction failed");
            } finally {
              abortRef.current = null;
              setBusy(false);
            }
          })();
          return;
        }
        case "init":
          if (busyRef.current) {
            echo(text);
            notice("busy — try /init again once the current turn finishes");
            return;
          }
          void runTurn(
            "Initialize project memory: survey this repository (use the repo map and read the key entry points, config, and docs) and write a concise GEARBOX.md at the repo root covering what the project is, how to build/test/run it, the layout, and any conventions a new contributor must know. Keep it tight and accurate.",
          );
          return;
        default:
          echo(text);
          notice(`unknown command: /${name} — try /help`);
          return;
      }
    },
    [exit, runTurn],
  );

  const submit = useCallback(
    (value: string) => {
      const text = value.trim();
      setEdit({ value: "", cursor: 0 });
      histIdxRef.current = null;
      if (!text) return;
      const h = historyRef.current;
      if (h[h.length - 1] !== text) h.push(text);
      appendHistory(text); // persist across runs
      if (text.startsWith("!")) {
        const cmd = text.slice(1).trim();
        echo(text);
        if (cmd) {
          const r = runShell(cmd);
          notice(r.output);
        }
        return;
      }
      if (text.startsWith("#")) {
        const note = text.slice(1).trim();
        echo(text);
        notice(note && appendFact(note) ? "remembered" : "usage: #<note to remember>");
        return;
      }
      if (text.startsWith("/")) {
        handleCommand(text);
        return;
      }
      if (busyRef.current) return;
      void runTurn(text);
    },
    [handleCommand, runTurn],
  );

  useInput((input, key) => {
    // Swallow any stray mouse-report bytes so they never land in the composer
    // (the wheel is handled by the raw stdin listener above).
    if (/\[<\d+;\d+;\d+[Mm]/.test(input)) return;
    // A pending permission request captures input until it's answered.
    if (permRef.current) {
      if (input === "1") resolvePerm("once");
      else if (input === "2") resolvePerm("always");
      else if (input === "a" || input === "A") resolvePerm("all");
      else if (input === "3" || key.escape) resolvePerm("deny");
      return;
    }
    // Keyboard scroll: PgUp/PgDn page through the transcript.
    if (key.pageUp || key.pageDown) {
      scrollBy((key.pageUp ? -1 : 1) * Math.max(1, Math.floor(viewportHeightRef.current / 2)));
      return;
    }
    if (key.tab && key.shift) {
      if (!busyRef.current) togglePlan();
      return;
    }
    if (key.tab) {
      if (!busyRef.current) {
        const m = currentMention(editRef.current.value, editRef.current.cursor);
        if (m) {
          const ms = matchFiles(listProjectFiles(), m.token);
          if (ms.length) {
            const r = completeMention(editRef.current.value, m, ms[0]!);
            setEdit({ value: r.value, cursor: r.cursor });
          }
        }
      }
      return;
    }
    const action = applyKey(editRef.current, input, key);
    if (busyRef.current) {
      if (action.type === "interrupt") {
        interruptedRef.current = true;
        abortRef.current?.abort();
      }
      return;
    }
    switch (action.type) {
      case "edit":
        setEdit(action.state);
        break;
      case "submit":
        submit(editRef.current.value);
        break;
      case "history": {
        const r = navHistory(historyRef.current, histIdxRef.current, action.dir);
        histIdxRef.current = r.idx;
        setEdit({ value: r.value, cursor: r.value.length });
        break;
      }
      case "interrupt":
        setEdit({ value: "", cursor: 0 });
        break;
      case "none":
        break;
    }
  }, { isActive: isRawModeSupported });

  const mention = currentMention(edit.value, edit.cursor);
  const fileMatches = mention ? matchFiles(listProjectFiles(), mention.token) : [];

  const welcome = items.length === 0;
  const cmdMatches = matchCommands(edit.value);
  const shownFiles = fileMatches.slice(0, 8);

  // The transcript as a flat styled-line buffer, wrapped to the full content width.
  const lineWidth = Math.max(width - 3, 20);
  const lines = useMemo(() => itemsToLines(items, lineWidth), [items, lineWidth]);

  // Footer height — over-estimated so the fullscreen frame never exceeds the
  // screen (alt-screen clips overflow, so under-filling is safe, over-filling
  // clips the status bar). HEADER is the title bar (marginTop + title + rule).
  let footer = 2; // status line + its top margin
  footer += perm ? 9 : 3; // permission card vs composer (rule + input + marginTop)
  if (busy || linger) footer += STATE_GHOST_ROWS + 1; // the fixed-height ghost line (+ marginTop)
  if (mode === "plan") footer += 2;
  if (cmdMatches.length) footer += cmdMatches.length + 1;
  if (shownFiles.length) footer += shownFiles.length + 2;
  const HEADER = 3;
  const transcriptHeight = Math.max(1, rows - HEADER - footer);
  const maxScroll = Math.max(0, lines.length - transcriptHeight);
  const effScroll = atBottomRef.current ? maxScroll : Math.min(scrollTop, maxScroll);
  viewportHeightRef.current = transcriptHeight;
  maxScrollRef.current = maxScroll;
  scrollTopRef.current = effScroll;

  // Keep scrollTop pinned to the bottom as new lines stream in (unless scrolled up).
  useEffect(() => {
    if (atBottomRef.current) setScrollTop(maxScroll);
  }, [lines.length, maxScroll]);

  const hero = (
    <Box flexDirection="column" alignItems="center">
      <MascotSplash skin={ghostSkin} size={splashSize} />
      <Box marginTop={1}>
        <Text color={color.dim}>talk or type </Text>
        <Text color={color.faint}>{glyph.bullet} </Text>
        <Text color={color.accentDim}>/</Text>
        <Text color={color.dim}>commands </Text>
        <Text color={color.accentDim}>@</Text>
        <Text color={color.dim}>files </Text>
        <Text color={color.accentDim}>!</Text>
        <Text color={color.dim}>shell</Text>
      </Box>
    </Box>
  );

  const footerJsx = (
    <>
      {busy || linger ? <Working state={mascotState} skin={ghostSkin} verb={verb} elapsed={elapsed} linger={linger && !busy} width={width} /> : null}
      <CommandPalette draft={edit.value} />
      <FilePalette matches={shownFiles} />
      {mode === "plan" ? (
        <Box paddingX={1} marginTop={1}>
          <Text color={color.accent}>{glyph.notice} plan mode</Text>
          <Text color={color.faint}> · read-only · shift+tab to exit</Text>
        </Box>
      ) : null}
      {perm ? (
        <PermissionPrompt req={perm} width={width} />
      ) : (
        <Composer value={edit.value} cursor={edit.cursor} placeholder={mode === "plan" ? "describe what to plan…" : "ask anything"} busy={busy} width={width} />
      )}
      <StatusBar model={modelLabel} branch={branch} routing={routing} yolo={yolo} ctxPct={ctxPct} tokens={tokens} width={width} />
    </>
  );

  if (fullscreen) {
    return (
      <Box flexDirection="column" width={width} height={rows}>
        <Banner model={modelLabel} cwd={basename(process.cwd())} width={width} />
        {welcome ? (
          <Box height={transcriptHeight} flexDirection="column" justifyContent="center">
            {hero}
          </Box>
        ) : (
          <Box paddingX={1}>
            <Viewport lines={lines} scrollTop={effScroll} height={transcriptHeight} width={width - 2} />
          </Box>
        )}
        {footerJsx}
      </Box>
    );
  }

  // Inline fallback (GEARBOX_INLINE=1): flows into native scrollback.
  return (
    <Box flexDirection="column" width={width}>
      <Banner model={modelLabel} cwd={basename(process.cwd())} width={width} />
      {welcome ? <Box marginTop={1}>{hero}</Box> : <Transcript items={items} width={width} />}
      {footerJsx}
    </Box>
  );
}
