import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdin } from "ink";
import type { ModelMessage } from "ai";
import { Banner } from "./components/Banner.tsx";
import { Transcript } from "./components/Transcript.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { FilePalette } from "./components/FilePalette.tsx";
import { Composer } from "./components/Composer.tsx";
import { Working } from "./components/Working.tsx";
import { MascotSplash, MascotMini } from "./components/Mascot.tsx";
import { nextVerb } from "./character.ts";
import { color, glyph } from "./theme.ts";
import type { Item } from "./types.ts";
import type { OnEvent, Usage } from "../agent/events.ts";
import { FixedSelector, type ModelSelector } from "../model/selector.ts";
import { findModel } from "../providers.ts";
import { runTask } from "../agent/run.ts";
import { runTaskMock } from "../agent/mock.ts";
import { runShell } from "../shell.ts";
import { helpText, formatModelList, resolveModelSwitch } from "../commands.ts";
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
}

export function App({ selector: initialSelector, demo, runner }: AppProps) {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const { columns } = useTerminalSize();
  const width = Math.min(columns, 100);

  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusyState] = useState(false);
  const [tokens, setTokens] = useState(0);
  const [lastInput, setLastInput] = useState(0);
  const [edit, setEditState] = useState<Edit>({ value: "", cursor: 0 });
  const [selector, setSelector] = useState<ModelSelector>(initialSelector);
  const [mode, setMode] = useState<"normal" | "plan">("normal");
  const [elapsed, setElapsed] = useState(0);
  const [verb, setVerb] = useState("Spinning up");

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
  const curAsstRef = useRef<number | null>(null);
  const historyRef = useRef<string[]>([]);
  const histIdxRef = useRef<number | null>(null);
  const lastPromptRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const interruptedRef = useRef(false);

  const setEdit = (e: Edit) => {
    editRef.current = e;
    setEditState(e);
  };
  const setBusy = (b: boolean) => {
    busyRef.current = b;
    setBusyState(b);
  };

  const branch = useMemo(() => gitBranch(), []);
  const model = useMemo(() => {
    try {
      return selector.select({ prompt: "" }).model;
    } catch {
      return null;
    }
  }, [selector]);
  const modelLabel = demo ? "demo · no key" : (model?.label ?? "none");
  const ctxPct = model && lastInput > 0 ? Math.round((lastInput / model.contextWindow) * 100) : null;

  const push = (it: Item) => setItems((prev) => [...prev, it]);
  const echo = (text: string) => push({ kind: "user", id: idRef.current++, text });
  const notice = (text: string) => push({ kind: "notice", id: idRef.current++, text });

  const defaultRunner: Runner = useCallback(
    async ({ prompt, messages, onEvent, selector: sel, signal }) => {
      if (demo) return runTaskMock({ prompt, messages, onEvent, signal });
      const choice = sel.select({ prompt });
      const withUser: ModelMessage[] = [...messages, { role: "user", content: prompt }];
      return runTask({ model: choice.model, messages: withUser, onEvent, signal, plan: modeRef.current === "plan" });
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
      curAsstRef.current = null;
      const ac = new AbortController();
      abortRef.current = ac;
      const toolMap = new Map<string, number>();

      const onEvent: OnEvent = (e) => {
        if (e.type === "text") {
          if (curAsstRef.current === null) {
            const id = idRef.current++;
            curAsstRef.current = id;
            setItems((prev) => [...prev, { kind: "assistant", id, text: e.text, done: false }]);
          } else {
            const id = curAsstRef.current;
            setItems((prev) => prev.map((i) => (i.id === id && i.kind === "assistant" ? { ...i, text: i.text + e.text } : i)));
          }
        } else if (e.type === "tool-start") {
          curAsstRef.current = null;
          const id = idRef.current++;
          toolMap.set(e.id, id);
          setItems((prev) => [...prev, { kind: "tool", id, callId: e.id, name: e.name, arg: e.arg, status: "running", summary: "" }]);
        } else if (e.type === "tool-end") {
          const id = toolMap.get(e.id);
          setItems((prev) => prev.map((i) => (i.id === id && i.kind === "tool" ? { ...i, status: e.ok ? "ok" : "err", summary: e.summary, diff: e.diff } : i)));
        } else if (e.type === "error") {
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
      } catch (err: any) {
        if (!ac.signal.aborted) onEvent({ type: "error", message: err?.message ?? String(err) });
      } finally {
        abortRef.current = null;
        setBusy(false);
        if (interruptedRef.current) {
          notice("interrupted");
          interruptedRef.current = false;
        }
      }
    },
    [runner, defaultRunner],
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
          setTokens(0);
          setLastInput(0);
          curAsstRef.current = null;
          return;
        case "help":
          echo(text);
          notice(helpText());
          return;
        case "plan":
          echo(text);
          togglePlan();
          return;
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
            notice(formatModelList(currentId));
            return;
          }
          {
            const r = resolveModelSwitch(arg);
            if (r.ok && r.modelId) setSelector(new FixedSelector(r.modelId));
            notice(r.message);
          }
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
      if (text.startsWith("!")) {
        const cmd = text.slice(1).trim();
        echo(text);
        if (cmd) {
          const r = runShell(cmd);
          notice(r.output);
        }
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

  return (
    <Box flexDirection="column" width={width}>
      <Banner model={modelLabel} width={width} />

      {items.length === 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <MascotSplash />
          <Box flexDirection="column" paddingX={1} marginTop={1}>
            <Text color={color.text}>Ready when you are.</Text>
            <Box>
              <Text color={color.dim}>Tell me what to build or fix — talk or type. </Text>
              <Text color={color.accentDim}>/</Text>
              <Text color={color.dim}> commands </Text>
              <Text color={color.accentDim}>@</Text>
              <Text color={color.dim}> files </Text>
              <Text color={color.accentDim}>!</Text>
              <Text color={color.dim}>shell</Text>
            </Box>
          </Box>
        </Box>
      ) : (
        <Transcript items={items} width={width} />
      )}

      {busy ? <Working elapsed={elapsed} verb={verb} /> : null}

      <CommandPalette draft={edit.value} />
      <FilePalette matches={fileMatches} />

      {mode === "plan" ? (
        <Box paddingX={1} marginTop={1}>
          <Text color={color.accent}>◆ plan mode</Text>
          <Text color={color.faint}> · read-only · shift+tab to exit</Text>
        </Box>
      ) : null}

      <MascotMini busy={busy} />
      <Composer value={edit.value} cursor={edit.cursor} placeholder={mode === "plan" ? "describe what to plan…" : "ask gearbox, or / for commands"} busy={busy} width={width} />

      <Box paddingX={1}>
        <Text color={color.faint}>
          / commands{"  "}
          {glyph.bullet}
          {"  "}↑↓ history{"  "}
          {glyph.bullet}
          {"  "}⏎ send
        </Text>
      </Box>

      <StatusBar model={modelLabel} cwd={basename(process.cwd())} branch={branch} ctxPct={ctxPct} tokens={tokens} width={width} />
    </Box>
  );
}
