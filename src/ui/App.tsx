import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdin } from "ink";
import type { ModelMessage } from "ai";
import { Banner } from "./components/Banner.tsx";
import { Transcript } from "./components/Transcript.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { CommandPalette, type PaletteRow } from "./components/CommandPalette.tsx";
import { FilePalette } from "./components/FilePalette.tsx";
import { Composer } from "./components/Composer.tsx";
import { MascotSplash, SKINS, type GhostSkin, type MascotState } from "./components/Mascot.tsx";
import { PermissionPrompt } from "./components/PermissionPrompt.tsx";
import { Working } from "./components/Working.tsx";
import { Viewport, type ViewSelection } from "./components/Viewport.tsx";
import { itemsToLines, type Line } from "./lines.ts";
import { setPermissionHandler, setYolo, isYolo, type PermRequest, type PermDecision } from "../permission.ts";
import { newSessionId, saveSession, loadSession, listSessions, loadHistory, appendHistory, type Session, type TurnMeta } from "../session.ts";
import { nextVerb } from "./character.ts";
import { color, glyph } from "./theme.ts";
import { loadPrefs, updatePrefs } from "./prefs.ts";
import type { AccountView, Item } from "./types.ts";
import type { OnEvent, Usage } from "../agent/events.ts";
import { FixedSelector, type ModelSelector } from "../model/selector.ts";
import { RoutingSelector, classify } from "../model/router.ts";
import { confirmRoutingPreference, type PreferenceKind } from "../model/preferences.ts";
import { effortLevels, normalizeEffort, clampEffort, type Effort } from "../model/reasoning.ts";
import { findModel, estimateCost, modelRegistry, type ModelSpec } from "../providers.ts";
import { runTask } from "../agent/run.ts";
import { AccountResolver, resolveCreds } from "../accounts/resolve.ts";
import { markUsed, listAccounts, loadAccounts, setDefaultAccount, removeAccount, getAccount, putAccount } from "../accounts/store.ts";
import { importableEnvCreds, importEnvCred, importableCloudCreds, importCloudCred } from "../accounts/detect.ts";
import { addApiKeyAccount, addAzureAccount, addAzureFoundryAccount, addByPastedKey, addOpenAICompatAccount, testAccount, addCliAccount, cliAuthStatus, cliLoginArgs } from "../accounts/onboard.ts";
import { catalogProvider, detectProviderByKey } from "../accounts/catalog.ts";
import { featuredApiKeyProviders, needsOnboarding, onboardingSummary, type OnboardingState } from "../accounts/onboarding.ts";
import { runCliTask, subscriptionEnv } from "../agent/cli-backend.ts";
import { recordUsage, recordRateLimits, recordBalance, buildUsageView, type UsageView } from "../accounts/usage.ts";
import { fetchBalance, balanceExposed } from "../accounts/balance.ts";
import { buildContext, sanitizeToolPairs } from "../context/builder.ts";
import { repoMap } from "../context/repomap.ts";
import { compactHistory, modelSummarizer, estimateHistoryTokens } from "../context/compact.ts";
import { appendFact, loadFacts } from "../context/memory.ts";
import { fetchUrlText, urlsInText } from "../fetch.ts";
import { imageChipLabel, imageContent, imagePathsInText, isImageFilePath, loadImageAttachment, replaceImagePathWithMarker, type ImageAttachment } from "../image.ts";
import { missingRequirements, type ModelRequirement } from "../model/capabilities.ts";
import { writeProjectGuide } from "../init.ts";
import { detectVerificationCommands, runVerification } from "../verify.ts";
import { runShellStream } from "../shell.ts";
import { helpText, formatModelList, resolveModelSwitch, matchCommands, buildContextView, formatAccounts, accountLabel, accountName, accountSlug } from "../commands.ts";
import { addMcpServer, formatMcpConfigList, mcpConfigPaths, mcpToolSummary, removeMcpServer, shellSplit } from "../mcp.ts";
import { applyKey, applyMouse, offsetAt, sanitizeInputText, selectionRange, type Edit, type MouseClick } from "./input.ts";
import { copyToClipboard } from "./clipboard.ts";
import { setTitle, bell, notify } from "./terminal.ts";
import { navHistory, searchHistory } from "./history.ts";
import { currentMention, matchFiles, completeMention } from "./mention.ts";
import { listProjectFiles, expandMentions } from "./files.ts";
import { useTerminalSize } from "./useTerminalSize.ts";
import { useOnline, isNetworkError } from "./net.ts";
import { gitBranch } from "./git.ts";
import { basename, extname, resolve } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { writeFile as fsWriteFile } from "node:fs/promises";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { spawnSyncProc, which } from "../proc.ts";

// Stateless: picks the active account per provider (reads the registry each call).
const accountResolver = new AccountResolver();

export type Runner = (opts: {
  prompt: string;
  messages: ModelMessage[];
  onEvent: OnEvent;
  selector: ModelSelector;
  signal: AbortSignal;
}) => Promise<{ messages: ModelMessage[]; usage: Usage }>;

const KEYS_HELP = [
  "Keyboard shortcuts",
  "  ⏎ send · ⌃J newline · esc interrupt · ⌃C twice to quit",
  "  ↑↓ history / move line · ← → cursor · ⌥/⌃ ← → word jump",
  "  ⌃A / ⌃E line start / end · ⌃U / ⌃K kill line · ⌃W kill word · ⌃D forward-delete",
  "  ⌃Y copy last reply · shift+tab cycle mode (normal · auto-accept · plan)",
  "  tab @file complete · PgUp/PgDn scroll transcript · type while busy to queue",
  "  / commands · @ files · ! shell · # memory · drag/paste image paths · ? this help",
  "  input stays fixed at the bottom; /config inline on uses terminal scrollback",
].join("\n");

/** Serialize the transcript to Markdown for /export. */
function transcriptMarkdown(items: Item[]): string {
  const out: string[] = ["# Gearbox transcript", ""];
  for (const it of items) {
    if (it.kind === "user") out.push("## You", "", it.text, "");
    else if (it.kind === "assistant") out.push("## Gearbox", "", it.text, "");
    else if (it.kind === "tool") out.push(`> \`${it.name}\` ${it.arg}${it.summary ? " — " + it.summary : ""}`, "");
    else if (it.kind === "notice") out.push(`_${it.text}_`, "");
    else if (it.kind === "accounts") {
      out.push("**accounts**", "", `current: ${it.view.current}`);
      for (const r of it.view.rows) out.push(`- ${r.name} (${r.type}) — ${r.status} — /account ${r.alias}`);
      out.push("");
    }
    else if (it.kind === "usage") {
      out.push("**usage · spend & limits**", "");
      for (const a of it.view.subscriptions) {
        const limits = (a.limits ?? []).map((l) => `${l.label} ${l.pct}%`).join(" · ");
        out.push(`- ${a.name} (subscription) — ${a.turns} turns${limits ? ` · ${limits}` : ""}`);
      }
      for (const a of it.view.apiKeys) out.push(`- ${a.name} (API key) — ${a.spend} · ${a.turns} turns · ${a.tok}`);
      out.push(`- total API spend ${it.view.totalApiSpend}`, "");
    } else if (it.kind === "context") {
      out.push("**context · what's loaded**", "");
      for (const r of it.view.rows) out.push(`- ${r.label.trim()} — ${r.display.trim()}`);
      out.push(`- total ${it.view.total.trim()}${it.view.windowPct != null ? ` (${it.view.windowPct}% of ${it.view.windowLabel})` : ""}`, "");
    } else if (it.kind === "error") out.push(`**error:** ${it.text}`, "");
  }
  return out.join("\n");
}

// Turn a raw error into something actionable. Network failures are the common
// case worth special-casing: say "you appear to be offline" + a retry hint
// instead of a stack-ish ENOTFOUND string.
function friendlyError(msg: string): string {
  if (isNetworkError(msg)) return `can't reach the provider — you appear to be offline. Check your connection, then /retry.`;
  return msg;
}

function firstPath(text: string): string | null {
  const m = text.match(/(?:^|\s)([./~\w-][^\s:]*\.[\w-]+)(?:\s|$)/);
  return m?.[1] ?? null;
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

type CliModelChoice = { id: string; label: string; provider: string; efforts?: string[] };

// Claude CLI has no --thinking-effort flag — effort is not passed through.
const CLAUDE_CLI_EFFORTS: string[] = [];
const FALLBACK_CODEX_MODELS: CliModelChoice[] = [
  { id: "gpt-5.5", label: "gpt-5.5", provider: "codex", efforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.4", label: "gpt-5.4", provider: "codex", efforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.4-mini", label: "gpt-5.4-mini", provider: "codex", efforts: ["low", "medium", "high", "xhigh"] },
];
let codexModelCache: CliModelChoice[] | null = null;

function codexCliModels(): CliModelChoice[] {
  if (codexModelCache) return codexModelCache;
  try {
    const r = spawnSyncProc(["codex", "debug", "models"], { stdout: "pipe", stderr: "ignore" });
    if (r.exitCode === 0) {
      const text = new TextDecoder().decode(r.stdout);
      const parsed = JSON.parse(text) as { models?: Array<{ slug?: string; visibility?: string; supported_reasoning_levels?: Array<{ effort?: string }> }> };
      const models = (parsed.models ?? [])
        .filter((m) => m.slug && m.visibility !== "hide")
        .map((m) => ({ id: m.slug!, label: m.slug!, provider: "codex", efforts: (m.supported_reasoning_levels ?? []).map((e) => e.effort).filter(Boolean) as string[] }));
      if (models.length) {
        codexModelCache = models;
        return models;
      }
    }
  } catch {
    /* fall back to the bundled Codex catalog below */
  }
  codexModelCache = FALLBACK_CODEX_MODELS;
  return codexModelCache;
}

function effortDescription(level: string): string {
  return ({
    none: "no extra reasoning",
    minimal: "minimal reasoning",
    low: "lighter reasoning",
    medium: "default reasoning",
    high: "deeper reasoning",
    xhigh: "extra-high reasoning",
    max: "maximum reasoning",
  } as Record<string, string>)[level] ?? "reasoning effort";
}

function previewLang(path: string): string {
  const ext = extname(path).slice(1).toLowerCase();
  return ({ tsx: "tsx", ts: "ts", jsx: "jsx", js: "js", py: "py", css: "css", json: "json", md: "md", sh: "sh" } as Record<string, string>)[ext] ?? ext;
}

function filePreview(path: string): { text: string; lines: number; lang: string } | null {
  try {
    if (!path || !existsSync(path)) return null;
    const st = statSync(path);
    if (!st.isFile() || st.size > 400_000) return null;
    const raw = readFileSync(path, "utf8").replace(/\r\n?/g, "\n");
    const lines = raw.split("\n");
    return { text: raw, lines: lines.length, lang: previewLang(path) };
  } catch {
    return null;
  }
}

function isWriteLikeTool(name: string): boolean {
  const n = name.toLowerCase();
  return n === "write_file" || n === "edit_file" || n === "write" || n === "edit" || n === "file_change";
}

function ActivityRail({ items, width }: { items: Item[]; width: number }) {
  const lastUser = items.map((it, i) => ({ it, i })).reverse().find((x) => x.it.kind === "user")?.i ?? -1;
  const turn = items.slice(lastUser + 1);
  const model = [...turn].reverse().find((i) => i.kind === "model") as Extract<Item, { kind: "model" }> | undefined;
  const phase = [...turn].reverse().find((i) => i.kind === "phase") as Extract<Item, { kind: "phase" }> | undefined;
  const tools = turn.filter((i): i is Extract<Item, { kind: "tool" }> => i.kind === "tool").slice(-3);
  const checks = turn.filter((i): i is Extract<Item, { kind: "verification" }> => i.kind === "verification").slice(-2);
  if (!model && !phase && !tools.length && !checks.length) return null;
  const spin = ["◐", "◓", "◑", "◒"][Math.floor(Date.now() / 160) % 4]!;
  const toolText = tools.map((t) => `${t.status === "running" ? spin : t.status === "err" ? "!" : "✓"} ${t.name.replace(/_file$/, "").replace("run_shell", "shell")}`).join(" · ");
  const checkText = checks.map((c) => `${c.ok ? "✓" : "!"} ${c.command}`).join(" · ");
  const line = [model ? model.model : null, phase ? phase.label : null, toolText || null, checkText || null].filter(Boolean).join("  ·  ");
  return (
    <Box paddingX={1} marginTop={1} width={width}>
      <Text color={color.accentDim}>activity </Text>
      <Text color={color.faint}>{line.slice(0, Math.max(width - 10, 20))}</Text>
    </Box>
  );
}

function SetupSplash({ state, width, skin, splashSize }: { state: OnboardingState; width: number; skin: GhostSkin; splashSize: "big" | "mini" | "none" }) {
  const detected = state.importable.length + state.cloudImportable.length;
  const panelWidth = Math.min(Math.max(width - 4, 30), 58);

  return (
    <Box flexDirection="column" alignItems="center">
      <MascotSplash skin={skin} size={splashSize} />

      <Box marginTop={1} flexDirection="column" alignItems="center">
        <Text color={color.accent} bold>gearbox</Text>
        <Text color={color.dim}>one terminal · every model you already pay for</Text>
      </Box>

      <Box marginTop={2} width={panelWidth} borderStyle="round" borderColor={color.faint} paddingX={2} paddingY={1} flexDirection="column">
        {detected > 0 ? (
          <>
            <Box>
              <Text color={color.ok}>{glyph.on} </Text>
              <Text color={color.text}>{detected} credential{detected > 1 ? "s" : ""} found on this machine</Text>
            </Box>
            <Box marginTop={1}>
              <Text color={color.accent}>/account import</Text>
              <Text color={color.dim}>  connect automatically</Text>
            </Box>
            <Box marginTop={1}>
              <Text color={color.faint}>or add a different key: </Text>
              <Text color={color.accent}>/account add &lt;api-key&gt;</Text>
            </Box>
          </>
        ) : (
          <>
            <Text color={color.dim}>paste or type a key to get started</Text>
            <Box marginTop={1}>
              <Text color={color.accent}>/account add &lt;api-key&gt;</Text>
            </Box>
          </>
        )}

        {(state.hasClaudeCli || state.hasCodexCli) && (
          <Box marginTop={2} flexDirection="column">
            <Text color={color.faint}>subscriptions detected</Text>
            {state.hasClaudeCli && (
              <Box>
                <Text color={color.accent}>/account add claude</Text>
                <Text color={color.faint}>  Claude Pro / Max</Text>
              </Box>
            )}
            {state.hasCodexCli && (
              <Box>
                <Text color={color.accent}>/account add codex</Text>
                <Text color={color.faint}>   ChatGPT Plus</Text>
              </Box>
            )}
          </Box>
        )}
      </Box>

      <Box marginTop={1}>
        <Text color={color.faint}>/onboard  ·  /account  ·  /help</Text>
      </Box>
    </Box>
  );
}

export interface AppProps {
  selector: ModelSelector;
  runner?: Runner;
  fullscreen?: boolean;
  resumeId?: string; // resume this saved session on launch (--continue)
}

export function App({ selector: initialSelector, runner, fullscreen = false, resumeId }: AppProps) {
  const { exit } = useApp();
  const { stdin, isRawModeSupported, setRawMode } = useStdin();
  const { columns, rows } = useTerminalSize();
  const online = useOnline(20_000, true); // background reachability → "⚠ offline"
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
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [selector, setSelector] = useState<ModelSelector>(initialSelector);
  const [mode, setMode] = useState<"normal" | "auto-accept" | "plan">("normal");
  const [effort, setEffortState] = useState<Effort>("medium");
  const [elapsed, setElapsed] = useState(0);
  const [verb, setVerb] = useState("Spinning up");
  const [ghostSkin, setGhostSkinState] = useState<GhostSkin>("base");
  // The in-flow ghost's face follows the agent's state. `linger` keeps the
  // working line up briefly after a turn for the celebrate/error beat.
  const [mascotState, setMascotState] = useState<MascotState>("thinking");
  const [linger, setLinger] = useState(false);
  const lingerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Type-ahead: prompts submitted while busy are queued and sent when the turn ends.
  const queueRef = useRef<string[]>([]);
  const [queued, setQueued] = useState<string[]>([]);
  const ctrlCRef = useRef(0); // timestamp of the last bare ⌃C (for "press again to quit")
  const escRef = useRef(0); // timestamp of the last bare esc (for double-esc rewind)
  const notifyRef = useRef(loadPrefs().notify !== false); // desktop notify on long turns (pref-gated)
  const firstRunRef = useRef(!loadPrefs().onboarded); // show setup tips until a real account exists
  // Large pastes collapse to a `[Pasted N lines]` chip in the composer; the real
  // text is kept here and expanded back in on submit.
  const pasteStoreRef = useRef<Map<string, string>>(new Map());
  const pasteIdRef = useRef(0);
  const copiedSelectionRef = useRef("");
  const mouseAnchorRef = useRef<number | null>(null);
  const transcriptMouseAnchorRef = useRef<{ line: number; col: number } | null>(null);
  const transcriptRangeAnchorRef = useRef<{ line: number; col: number } | null>(null);
  const lastComposerClickRef = useRef<{ time: number; x: number; y: number; count: number } | null>(null);
  const lastTranscriptClickRef = useRef<{ time: number; x: number; y: number; count: number } | null>(null);
  const linesRef = useRef<Line[]>([]);
  const scrollTopLiveRef = useRef(0);
  const transcriptHeightLiveRef = useRef(1);
  const [transcriptSelection, setTranscriptSelectionState] = useState<ViewSelection | null>(null);
  const transcriptSelectionRef = useRef<ViewSelection | null>(null);
  const [copiedNotice, setCopiedNotice] = useState<string | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const outCharsRef = useRef(0); // streamed output chars this turn (for a live tok/s estimate)
  const [, bumpMotion] = useReducer((x: number) => x + 1, 0);
  const [yolo, setYoloState] = useState(isYolo());
  const [perm, setPermState] = useState<PermRequest | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [expandAll, setExpandAll] = useState(false); // ⌃O: show full diffs/tool output
  const [search, setSearchState] = useState<{ q: string; idx: number } | null>(null); // ⌃R reverse-i-search
  const [paletteIndex, setPaletteIndexState] = useState(0);
const searchRef = useRef<{ q: string; idx: number } | null>(null);
  const paletteIndexRef = useRef(0);
  const setSearch = (s: { q: string; idx: number } | null) => {
    searchRef.current = s;
    setSearchState(s);
  };
  const setPaletteIndex = (n: number) => {
    paletteIndexRef.current = n;
    setPaletteIndexState(n);
  };

  useEffect(() => {
    if (!busy && !linger) return;
    const id = setInterval(() => bumpMotion(), 120);
    return () => clearInterval(id);
  }, [busy, linger]);
  const [vim, setVimState] = useState<"off" | "insert" | "normal">(loadPrefs().vim ? "insert" : "off"); // composer vim mode
  const vimRef = useRef(vim);
  const setVim = (v: "off" | "insert" | "normal") => {
    vimRef.current = v;
    setVimState(v);
  };
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

  // Reflect status in the terminal window/tab title (OSC 2).
  useEffect(() => {
    const proj = basename(process.cwd());
    setTitle(busy ? `✳ ${proj} · working` : `${proj} · gearbox`);
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
  // Active CLI-backed subscription account (claude/codex). When set, turns run
  // through the vendor binary (its own loop/tools/permissions), not the in-loop
  // path. cliSessionRef keeps the binary's session id for resume.
  const activeCliRef = useRef<{ id: string; binary: string; profile?: string } | null>(null);
  const activeCliModelRef = useRef<string | undefined>(undefined);
  const cliSessionRef = useRef<string | undefined>(undefined);
  const activeImagesRef = useRef<ImageAttachment[]>([]);
  const imageChipPathsRef = useRef<Map<string, string>>(new Map());
  const accountStatusCacheRef = useRef<Record<string, { signedIn?: boolean; detail?: string; duplicateOf?: string; identity?: string }>>({});
  // Which account ran the last turn + its provider-reported cost/limit (for the
  // per-account spend ledger; see src/accounts/usage.ts).
  const usedAccountRef = useRef<string | null>(null);
  const cliMetaRef = useRef<{ costUSD?: number; rates?: { utilization: number; resetsAt?: number; type?: string }[] } | null>(null);
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

  // Restore the active subscription account from a prior session (persisted in
  // prefs.activeAccount), so /account choices survive restarts.
  useEffect(() => {
    const acctId = loadPrefs().activeAccount;
    if (!acctId) return;
    const a = getAccount(acctId);
    if (a && a.exec === "cli") {
      const bin = (a.auth as any).binary as string;
      activeCliRef.current = { id: a.id, binary: bin, profile: (a.auth as any).loginProfile };
      if (activeCliModelRef.current && !cliSupportsModel(bin, activeCliModelRef.current)) setActiveCliModelId(undefined);
      setActiveCli({ id: a.id, label: bin });
    }
  }, []);

  // Mutating tools (write/edit/shell) block on this; the UI resolves it.
  useEffect(() => {
    setPermissionHandler(
      (req) =>
        new Promise<PermDecision>((resolve) => {
          // Auto-accept-edits mode: apply file writes/edits without asking (the
          // diff still renders); shell commands are still gated.
          if (modeRef.current === "auto-accept" && (req.kind === "write" || req.kind === "edit")) {
            resolve("once");
            return;
          }
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

  const copyWithFeedback = useCallback((text: string) => {
    const clean = text.replace(/[ \t]+\n/g, "\n").trim();
    if (!clean) return;
    copyToClipboard(clean);
    setCopiedNotice(`copied ${clean.length} chars to clipboard`);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopiedNotice(null), 1400);
  }, []);
  const flashStatus = useCallback((text: string) => {
    setCopiedNotice(text);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopiedNotice(null), 1200);
  }, []);

  const lineText = (line: Line) => line.map((s) => s.text).join("");
  const textFromTranscriptSelection = (sel: ViewSelection): string => {
    const aBeforeB = sel.startLine < sel.endLine || (sel.startLine === sel.endLine && sel.startCol <= sel.endCol);
    const start = aBeforeB ? { line: sel.startLine, col: sel.startCol } : { line: sel.endLine, col: sel.endCol };
    const end = aBeforeB ? { line: sel.endLine, col: sel.endCol } : { line: sel.startLine, col: sel.startCol };
    const out: string[] = [];
    for (let i = start.line; i <= end.line; i++) {
      const text = lineText(linesRef.current[i] ?? []);
      const from = i === start.line ? start.col : 0;
      const to = i === end.line ? end.col : text.length;
      out.push(text.slice(Math.max(0, from), Math.max(0, to)));
    }
    return out.join("\n");
  };
  const normalizedTranscriptSelection = (sel: ViewSelection): ViewSelection => {
    const aBeforeB = sel.startLine < sel.endLine || (sel.startLine === sel.endLine && sel.startCol <= sel.endCol);
    return aBeforeB ? sel : { startLine: sel.endLine, startCol: sel.endCol, endLine: sel.startLine, endCol: sel.startCol };
  };
  const transcriptWordRange = (point: { line: number; col: number }): ViewSelection => {
    const text = lineText(linesRef.current[point.line] ?? []);
    if (!text) return { startLine: point.line, startCol: 0, endLine: point.line, endCol: 0 };
    const col = Math.max(0, Math.min(point.col, Math.max(0, text.length - 1)));
    const isWord = (ch: string) => /[\p{L}\p{N}_$.-]/u.test(ch);
    const targetWord = isWord(text[col] ?? "");
    let start = col;
    let end = col + 1;
    while (start > 0 && isWord(text[start - 1] ?? "") === targetWord && !/\s/.test(text[start - 1]!)) start--;
    while (end < text.length && isWord(text[end] ?? "") === targetWord && !/\s/.test(text[end]!)) end++;
    if (!targetWord) {
      while (start > 0 && /\s/.test(text[start - 1]!)) start--;
      while (end < text.length && /\s/.test(text[end]!)) end++;
    }
    return { startLine: point.line, startCol: start, endLine: point.line, endCol: end };
  };
  const transcriptLineRange = (point: { line: number; col: number }): ViewSelection => {
    const text = lineText(linesRef.current[point.line] ?? []);
    return { startLine: point.line, startCol: 0, endLine: point.line, endCol: text.length };
  };
  const copyTranscriptSelection = (sel: ViewSelection) => {
    const norm = normalizedTranscriptSelection(sel);
    if (norm.startLine === norm.endLine && norm.startCol === norm.endCol) return;
    copyWithFeedback(textFromTranscriptSelection(norm));
  };
  const transcriptClickCount = (x: number, y: number): number => {
    const now = Date.now();
    const prev = lastTranscriptClickRef.current;
    const near = prev && now - prev.time < 500 && Math.abs(prev.x - x) <= 1 && prev.y === y;
    const count = near ? Math.min(prev.count + 1, 3) : 1;
    lastTranscriptClickRef.current = { time: now, x, y, count };
    return count;
  };

  // SGR mouse handling. Wheel scrolls the transcript; drag inside the bottom
  // composer selects input text so Backspace/Delete can edit it like a real field.
  useEffect(() => {
    if (!stdin || process.env.GEARBOX_MOUSE === "0") return;
    const composerOffset = (x: number, y: number): number | null => {
      if (busyRef.current || permRef.current) return null;
      const value = editRef.current.value;
      const lineCount = Math.max(1, value.split("\n").length);
      const firstInputRow = rows - lineCount + 1;
      if (y < firstInputRow || y > rows) return null;
      const lineIdx = y - firstInputRow;
      const col = Math.max(0, x - 4); // 1 pad + prompt + space, SGR coords are 1-based
      return offsetAt(value, lineIdx, col);
    };
    const viewportTop = 4; // Banner is 3 rows; viewport begins on row 4.
    const transcriptPoint = (x: number, y: number): { line: number; col: number } | null => {
      const viewportBottom = viewportTop + transcriptHeightLiveRef.current - 1;
      if (y < viewportTop || y > viewportBottom) return null;
      const line = scrollTopLiveRef.current + (y - viewportTop);
      const text = lineText(linesRef.current[line] ?? []);
      return { line, col: Math.max(0, Math.min(text.length, x - 2)) };
    };
    const onData = (d: Buffer | string) => {
      const s = d.toString();
      let delta = 0;
      const re = /\x1b?\[<(\d+);(\d+);(\d+)([Mm])/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(s))) {
        const b = Number(m[1]);
        const x = Number(m[2]);
        const y = Number(m[3]);
        const up = m[4] === "m";
        if (b === 64) delta -= 1;
        else if (b === 65) delta += 1;
        else {
          const off = composerOffset(x, y);
          const point = transcriptPoint(x, y);
          const isDrag = (b & 32) === 32;
          const isPrimary = (b & 3) === 0;
          if (isPrimary && isDrag && transcriptMouseAnchorRef.current && !point) {
            const bottom = viewportTop + transcriptHeightLiveRef.current - 1;
            if (y < viewportTop) scrollBy(-2);
            else if (y > bottom) scrollBy(2);
            const edgeLine = y < viewportTop ? scrollTopLiveRef.current : scrollTopLiveRef.current + transcriptHeightLiveRef.current - 1;
            const edgeText = lineText(linesRef.current[edgeLine] ?? []);
            setTranscriptSel({
              startLine: transcriptMouseAnchorRef.current.line,
              startCol: transcriptMouseAnchorRef.current.col,
              endLine: edgeLine,
              endCol: y < viewportTop ? 0 : edgeText.length,
            });
            continue;
          }
          if (up) {
            if (transcriptMouseAnchorRef.current) {
              const end = point;
              const start = transcriptMouseAnchorRef.current;
              transcriptMouseAnchorRef.current = null;
              if (end && (end.line !== start.line || end.col !== start.col)) {
                const sel = { startLine: start.line, startCol: start.col, endLine: end.line, endCol: end.col };
                setTranscriptSel(sel);
                copyWithFeedback(textFromTranscriptSelection(sel));
              } else if (!end && transcriptSelectionRef.current) {
                copyWithFeedback(textFromTranscriptSelection(transcriptSelectionRef.current));
              }
            }
            mouseAnchorRef.current = null;
          } else if (off != null && isPrimary && !isDrag) {
            // Composer click: track timing for double/triple-click detection.
            // SGR x is 1-based. composerOffset computes the 0-based col within
            // the text (subtracts 4: 1 pad + "❯ " prompt + space). Re-derive the
            // 0-based line index from y so applyMouse gets correct col/line.
            const value = editRef.current.value;
            const lineCount = Math.max(1, value.split("\n").length);
            const firstInputRow = rows - lineCount + 1;
            const lineIdx = y - firstInputRow;
            const col = Math.max(0, x - 4);
            const shift = (b & 4) !== 0;
            const now = Date.now();
            const prev = lastComposerClickRef.current;
            let clickCount = 1;
            if (prev && now - prev.time < 500 && prev.x === x && prev.y === y) {
              clickCount = Math.min(prev.count, 3) + 1;
            }
            lastComposerClickRef.current = { time: now, x, y, count: clickCount };
            const click: MouseClick = { line: lineIdx, col, count: clickCount, shift };
            mouseAnchorRef.current = off;
            transcriptMouseAnchorRef.current = null;
            setTranscriptSel(null);
            const action = applyMouse({ value, cursor: editRef.current.cursor, selectionAnchor: editRef.current.selectionAnchor }, click);
            if (action.type === "edit") setEdit(action.state);
            else setEdit({ value, cursor: off });
          } else if (off != null && isDrag && mouseAnchorRef.current != null) {
            // Extend selection from anchor, but only for single-click drags.
            // Double/triple-click sets word/line selection; a drag event immediately
            // after (common on trackpads with micro-motion) must not clobber it.
            const lastCount = lastComposerClickRef.current?.count ?? 1;
            if (lastCount === 1) {
              setEdit({ value: editRef.current.value, cursor: off, selectionAnchor: mouseAnchorRef.current });
            }
          } else if (point && isPrimary && !isDrag) {
            const shift = (b & 4) !== 0;
            const clickCount = transcriptClickCount(x, y);
            mouseAnchorRef.current = null;
            setEdit({ ...editRef.current, selectionAnchor: undefined });
            if (shift) {
              const existing = transcriptSelectionRef.current ? normalizedTranscriptSelection(transcriptSelectionRef.current) : null;
              const anchor = transcriptRangeAnchorRef.current ?? (existing ? { line: existing.startLine, col: existing.startCol } : point);
              transcriptMouseAnchorRef.current = null;
              transcriptRangeAnchorRef.current = anchor;
              const sel = { startLine: anchor.line, startCol: anchor.col, endLine: point.line, endCol: point.col };
              setTranscriptSel(sel);
              copyTranscriptSelection(sel);
            } else if (clickCount >= 3) {
              const sel = transcriptLineRange(point);
              const norm = normalizedTranscriptSelection(sel);
              transcriptMouseAnchorRef.current = null;
              transcriptRangeAnchorRef.current = { line: norm.startLine, col: norm.startCol };
              setTranscriptSel(sel);
              copyTranscriptSelection(sel);
            } else if (clickCount === 2) {
              const sel = transcriptWordRange(point);
              const norm = normalizedTranscriptSelection(sel);
              transcriptMouseAnchorRef.current = null;
              transcriptRangeAnchorRef.current = { line: norm.startLine, col: norm.startCol };
              setTranscriptSel(sel);
              copyTranscriptSelection(sel);
            } else {
              transcriptMouseAnchorRef.current = point;
              transcriptRangeAnchorRef.current = point;
              setTranscriptSel({ startLine: point.line, startCol: point.col, endLine: point.line, endCol: point.col });
            }
          } else if (point && isDrag && transcriptMouseAnchorRef.current) {
            setTranscriptSel({ startLine: transcriptMouseAnchorRef.current.line, startCol: transcriptMouseAnchorRef.current.col, endLine: point.line, endCol: point.col });
          }
        }
      }
      if (delta) scrollBy(delta);
    };
    stdin.on("data", onData);
    return () => {
      stdin.off?.("data", onData);
    };
  }, [stdin, fullscreen, rows, scrollBy, copyWithFeedback]);

  // Save the current conversation (best-effort) — model-agnostic messages + the UI
  // transcript + per-turn model/usage, so it resumes faithfully and feeds routing.
  const persist = useCallback(() => {
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
  }, []);

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
    const cleanValue = sanitizeInputText(e.value);
    if (cleanValue !== e.value) {
      const delta = e.value.length - cleanValue.length;
      e = { ...e, value: cleanValue, cursor: Math.max(0, e.cursor - delta) };
    }
    editRef.current = e;
    const sel = selectionRange(e);
    const selectedText = sel ? e.value.slice(sel[0], sel[1]) : "";
    if (selectedText && selectedText !== copiedSelectionRef.current) {
      copiedSelectionRef.current = selectedText;
      copyWithFeedback(selectedText);
    } else if (!selectedText) {
      copiedSelectionRef.current = "";
    }
    setEditState(e);
  };
  const setBusy = (b: boolean) => {
    busyRef.current = b;
    setBusyState(b);
  };
  const setTranscriptSel = (sel: ViewSelection | null) => {
    transcriptSelectionRef.current = sel;
    setTranscriptSelectionState(sel);
  };
  const imageMarkerFor = (path: string): string => {
    for (const [marker, existing] of imageChipPathsRef.current) {
      if (existing === path) return marker;
    }
    let idx = 1;
    let marker = imageChipLabel(path);
    while (imageChipPathsRef.current.has(marker)) {
      idx++;
      marker = imageChipLabel(path, idx);
    }
    imageChipPathsRef.current.set(marker, path);
    return marker;
  };
  const chipImagePathsIn = (text: string): string[] => {
    const paths: string[] = [];
    for (const [marker, path] of imageChipPathsRef.current) {
      if (text.includes(marker)) paths.push(path);
    }
    return paths;
  };
  const cliCatalogId = (binary: string) => (binary.includes("codex") ? "codex-cli" : binary.includes("claude") ? "claude-cli" : "");
  const cliModelChoices = (binary: string): CliModelChoice[] => {
    if (binary.includes("codex")) return codexCliModels();
    const provider = binary.includes("claude") ? "anthropic" : binary;
    return (catalogProvider(cliCatalogId(binary))?.defaultModels ?? []).map((id) => {
      const m = findModel(id);
      return { id, label: m?.label ?? id, provider, efforts: binary.includes("claude") ? CLAUDE_CLI_EFFORTS : m ? effortLevels(m) : undefined };
    });
  };
  const cliSupportsModel = (binary: string, modelId: string) => {
    return cliModelChoices(binary).some((m) => m.id === modelId);
  };
  const cliModelLabel = (modelId?: string) => (modelId ? findModel(modelId)?.label ?? modelId : null);
  const effortTarget = (): { label: string; efforts: string[]; provider: string } | null => {
    const cli = activeCliRef.current;
    if (cli) {
      const choices = cliModelChoices(cli.binary);
      const model = choices.find((m) => m.id === activeCliModelRef.current) ?? choices[0];
      return model ? { label: model.label, efforts: model.efforts ?? [], provider: model.provider } : null;
    }
    try {
      const model = selectorRef.current.select({ prompt: "" }).model;
      return { label: model.label, efforts: effortLevels(model), provider: model.provider };
    } catch {
      return null;
    }
  };
  const effortRows = (): PaletteRow[] => {
    const target = effortTarget();
    if (!target?.efforts.length) return [];
    return target.efforts.map((level) => ({ value: `/effort ${level}`, label: level, detail: `${target.label} / ${effortDescription(level)}` }));
  };
  const formatCliModelList = (binary: string, currentId: string | null): string => {
    const models = cliModelChoices(binary);
    const rows = [
      "models · /model <name> pins one for this subscription · /model auto uses the subscription default",
      "",
      `${binary} subscription`,
    ];
    if (!models.length) rows.push("  no named subscription models exposed yet");
    for (const m of models) rows.push(`  ${m.id === currentId ? glyph.on : glyph.off} ${m.label}`);
    rows.push("", "API models are hidden while a subscription is active — /account off returns to API routing\n  tip: /model haiku (or any API model name) switches directly and leaves the subscription");
    return rows.join("\n");
  };
  const resolveCliModel = (binary: string, query: string): { ok: true; modelId: string; label: string } | { ok: false; message: string } => {
    const q = query.trim().toLowerCase();
    const matches = cliModelChoices(binary).filter((m) => m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
    if (!matches.length) return { ok: false, message: `no ${binary} subscription model matching "${query}"` };
    const exact = matches.find((m) => m.label.toLowerCase() === q || m.id.toLowerCase() === q);
    const m = exact ?? (matches.length === 1 ? matches[0] : undefined);
    if (!m) return { ok: false, message: `"${query}" matches ${matches.map((x) => x.label).join(", ")} — be more specific` };
    return { ok: true, modelId: m.id, label: m.label };
  };
  const setActiveCliModelId = (modelId: string | undefined) => {
    activeCliModelRef.current = modelId;
    setActiveCliModel(cliModelLabel(modelId));
  };

  const commandPickerRows = (draft: string): PaletteRow[] => {
    const [headRaw, ...rest] = draft.trimStart().split(/\s+/);
    const head = (headRaw ?? "").toLowerCase();
    const q = rest.join(" ").toLowerCase();
    const take = (rows: PaletteRow[]) => rows.filter((r) => !q || `${r.label} ${r.detail ?? ""} ${r.value}`.toLowerCase().includes(q)).slice(0, 7);
    if (head === "/model") {
      const cli = activeCliRef.current;
      const models = cli ? cliModelChoices(cli.binary) : modelRegistry();
      return take([
        { value: "/model auto", label: "auto", detail: cli ? "use subscription default" : "route per task" },
        ...models.map((m) => ({ value: `/model ${m.label}`, label: m.label, detail: cli ? `${cli.binary} subscription` : `${m.provider} · ${m.id}` })),
      ]);
    }
    if (head === "/account" || head === "/accounts") {
      const rows = listAccounts().map((a) => ({ value: `/account ${accountSlug(a)}`, label: accountName(a), detail: a.exec === "cli" ? "subscription" : `${a.provider} API key` }));
      return take([
        { value: "/account off", label: "off", detail: "use API routing" },
        ...rows,
        { value: "/account add codex", label: "add codex", detail: "ChatGPT subscription" },
        { value: "/account add codex work", label: "add codex work", detail: "second ChatGPT account" },
        { value: "/account add claude", label: "add claude", detail: "Claude subscription" },
        { value: "/account add claude work", label: "add claude work", detail: "second Claude account" },
        { value: "/account add", label: "add key", detail: "paste an API key" },
      ]);
    }
    if (head === "/effort") {
      return take(effortRows());
    }
    if (head === "/resume") return take(listSessions().slice(0, 7).map((s, i) => ({ value: `/resume ${i + 1}`, label: `${i + 1}. ${s.title || "(untitled)"}`.slice(0, 42), detail: new Date(s.updatedAt).toLocaleDateString() })));
    return [];
  };
  const isExactSlashCommand = (draft: string): boolean => {
    const q = draft.trim();
    if (!/^\/\S+$/.test(q)) return false;
    return matchCommands(q).some((c) => c.name === q);
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
  // Mirrors activeCliRef as state so the status line re-renders when you /login
  // to (or leave) a subscription account.
  const [activeCli, setActiveCli] = useState<{ id: string; label: string } | null>(null);
  const [activeCliModel, setActiveCliModel] = useState<string | null>(null);
  const onboardingState = {
    configured: listAccounts(),
    importable: importableEnvCreds(),
    cloudImportable: importableCloudCreds().map((c) => ({ provider: c.provider, label: c.label, source: c.source })),
    hasClaudeCli: Boolean(which("claude")),
    hasCodexCli: Boolean(which("codex")),
  };
  const setupRequired = needsOnboarding(onboardingState);
  useEffect(() => {
    if (!setupRequired && firstRunRef.current) {
      firstRunRef.current = false;
      updatePrefs({ onboarded: true });
    }
  }, [setupRequired]);
  const model = lastPick?.model ?? choice?.model ?? null;
  // On a subscription, the status reflects the CLI account, not the in-loop model/routing.
  const modelLabel = setupRequired ? "setup required" : activeCli ? `${activeCli.label}${activeCliModel ? ` · ${activeCliModel}` : ""}` : (model?.label ?? "none");
  const subscription = activeCli ? activeCli.label : null;
  const routing = setupRequired || activeCli ? null : (lastPick?.reason ?? choice?.reason ?? null);
  const ctxPct = !activeCli && model && lastInput > 0 ? Math.round((lastInput / model.contextWindow) * 100) : null;
  // Only show effort when the active model actually supports reasoning — avoids showing
  // "effort medium" on models like haiku that have no reasoning support.
  const activeModelEfforts = (() => {
    const cli = activeCliRef.current;
    if (cli) {
      const choices = cliModelChoices(cli.binary);
      const m = choices.find((c) => c.id === activeCliModel) ?? choices[0];
      return m?.efforts ?? [];
    }
    return model ? effortLevels(model) : [];
  })();
  const displayEffort = activeModelEfforts.length > 0 ? effort : undefined;

  const push = (it: Item) => setItems((prev) => [...prev, it]);
  const pushPhase = (label: string, detail?: string) => {
    const id = idRef.current++;
    push({ kind: "phase", id, label, detail, state: "running" });
    return id;
  };
  const updatePhase = (id: number, state: "running" | "ok" | "err", label: string, detail?: string) => {
    setItems((prev) => prev.map((it) => (it.id === id && it.kind === "phase" ? { ...it, state, label, detail } : it)));
  };
  const echo = (text: string) => push({ kind: "user", id: idRef.current++, text });
  const notice = (text: string) => push({ kind: "notice", id: idRef.current++, text });
  const pushUsage = (view: UsageView) => push({ kind: "usage", id: idRef.current++, view });
  const pushAccounts = (view: AccountView) => push({ kind: "accounts", id: idRef.current++, view });

  const normalizeAccountRef = (s: string) =>
    s.toLowerCase()
      .replace(/[()]/g, " ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const accountAliases = (a: ReturnType<typeof listAccounts>[number], index: number) => {
    const name = accountName(a);
    const slug = accountSlug(a);
    const aliases = new Set([String(index + 1), slug, normalizeAccountRef(name), normalizeAccountRef(a.label), normalizeAccountRef(a.id)]);
    const nick = name.match(/\(([^)]+)\)/)?.[1];
    if (nick) aliases.add(normalizeAccountRef(nick));
    if (a.provider === "codex-cli") aliases.add("chatgpt");
    if (a.provider === "claude-cli") aliases.add("claude");
    return aliases;
  };
  const findAccountRef = (query: string, accounts = listAccounts()): { account?: (typeof accounts)[number]; error?: string } => {
    const q = normalizeAccountRef(query);
    if (!q) return { error: "which account? use /account <name-or-number>" };
    const exact = accounts.map((a, i) => ({ a, aliases: accountAliases(a, i) })).filter(({ aliases }) => aliases.has(q));
    if (exact.length === 1) return { account: exact[0]!.a };
    if (exact.length > 1) return { error: `"${query}" matches ${exact.map(({ a }) => accountName(a)).join(", ")} — use the full alias` };
    const fuzzy = accounts.map((a, i) => ({ a, aliases: [...accountAliases(a, i)] })).filter(({ aliases }) => aliases.some((x) => x.includes(q)));
    if (fuzzy.length === 1) return { account: fuzzy[0]!.a };
    if (fuzzy.length > 1) return { error: `"${query}" matches ${fuzzy.map(({ a }) => accountName(a)).join(", ")} — use the full alias` };
    return { error: `no account matching "${query}"` };
  };
  const buildAccountView = (
    accounts: ReturnType<typeof listAccounts>,
    activeCliId: string | null,
    importable: { provider: string; label: string; envVar: string }[],
    statuses: Record<string, { signedIn?: boolean; detail?: string; duplicateOf?: string; identity?: string }>,
  ): AccountView => {
    const active = activeCliId ? accounts.find((a) => a.id === activeCliId) : null;
    const rows = accounts.map((a, i) => {
      const st = statuses[a.id];
      const activeRow = a.id === activeCliId;
      const status =
        activeRow ? "active" :
        st?.duplicateOf ? "duplicate" :
        st?.signedIn === false ? "not signed in" :
        st?.signedIn === true ? "signed in" :
        a.exec === "cli" ? "not checked" :
        "ready";
      return {
        name: accountName(a),
        type: (a.exec === "cli" ? "subscription" : "API key") as "subscription" | "API key",
        status,
        active: activeRow,
        alias: accountSlug(a),
        number: i + 1,
        detail: st?.signedIn ? st.detail : undefined,
        duplicateOf: st?.duplicateOf,
      };
    });
    return {
      current: active ? accountLabel(active) : "API routing",
      rows,
      importable,
      labelPad: Math.max(12, ...rows.map((r) => r.name.length)),
      statusPad: Math.max(6, ...rows.map((r) => r.status.length)),
    };
  };

  const defaultRunner: Runner = useCallback(
    async ({ prompt, messages, onEvent, selector: sel, signal }) => {
      // Active CLI subscription account: delegate the whole turn to the vendor
      // binary (account-first; the model selector doesn't apply). Plain-text
      // transcript carries across; the binary self-governs tools/permissions.
      const cli = activeCliRef.current;
      if (cli) {
        if (activeImagesRef.current.length) {
          onEvent({
            type: "error",
            message: "image attachments need an API-backed model in Gearbox right now. Use `/account off` or an API-key account, then retry with the image path.",
          });
          return { messages, usage: { inputTokens: 0, outputTokens: 0 } };
        }
        routedRef.current = null;
        usedAccountRef.current = cli.id;
        const modelLabel = cliModelLabel(activeCliModelRef.current);
        onEvent({ type: "phase", label: "using subscription", detail: `${cli.binary}${modelLabel ? ` · ${modelLabel}` : ""} owns tools and permissions`, state: "running" });
        const cliChoices = cliModelChoices(cli.binary);
        const cliChoice = cliChoices.find((m) => m.id === activeCliModelRef.current) ?? cliChoices[0];
        const _cliEffortRaw = cliChoice ? normalizeEffort(effortRef.current, cliChoice.efforts ?? []) : null;
        if (_cliEffortRaw === null && effortRef.current !== "medium") {
          const supported = cliChoice?.efforts ?? [];
          const { level: nearest } = clampEffort(effortRef.current, supported);
          const hint = supported.length ? ` — try /effort ${nearest}` : "";
          throw new Error(`effort "${effortRef.current}" is not supported by ${cliChoice?.label ?? cli.binary} (supports: ${supported.join(", ") || "none"}${hint})`);
        }
        const cliEffort = _cliEffortRaw ?? undefined;
        const activeAccount = getAccount(cli.id);
        const activeName = activeAccount ? accountName(activeAccount).match(/\((.*)\)/)?.[1] : undefined;
        const reloginCommand = cli.binary.includes("codex")
          ? `/account add codex${activeName ? ` ${activeName}` : ""}`
          : `/account add claude${activeName ? ` ${activeName}` : ""}`;
        // On the first turn of a session, inject the repo map so the model
        // doesn't waste tool calls on find/ls to discover the file structure.
        // The CLI backend bypasses gearbox's context engine entirely, so this
        // is the only way to give it structural context upfront.
        let cliPrompt = prompt;
        if (!cliSessionRef.current) {
          try {
            const cwd = process.cwd();
            const allFiles = listProjectFiles(cwd).slice(0, 300);
            const map = repoMap(cwd, 3000);
            const fileList = allFiles.join("\n");
            cliPrompt =
              `<project-context cwd="${cwd}">\n` +
              `<files>\n${fileList}\n</files>\n` +
              (map ? `<signatures>\n${map}\n</signatures>\n` : "") +
              `</project-context>\n\n` +
              prompt;
          } catch {
            // non-critical — proceed with plain prompt
          }
        }
        const r = await runCliTask({
          binary: cli.binary,
          prompt: cliPrompt,
          messages,
          onEvent,
          signal,
          sessionId: cliSessionRef.current,
          autoApprove: isYolo(),
          profile: cli.profile,
          modelId: activeCliModelRef.current,
          effort: cliEffort,
          accountLabel: activeAccount ? accountLabel(activeAccount) : cli.id,
          reloginCommand,
        });
        cliSessionRef.current = r.sessionId ?? cliSessionRef.current;
        cliMetaRef.current = { costUSD: r.costUSD, rates: r.rates };
        return { messages: r.messages, usage: r.usage };
      }
      const plan = modeRef.current === "plan";
      const requires: ModelRequirement[] = ["tools", ...(activeImagesRef.current.length ? ["images" as const] : [])];
      const choice = sel.select({ prompt: prompt, kind: plan ? "plan" : undefined, requires });
      const missing = missingRequirements(choice.model, requires);
      if (missing.length) {
        throw new Error(`${choice.model.label} cannot run this turn (${missing.join(", ")} unsupported). Use /model auto or pick a compatible model.`);
      }
      // Record the ACTUAL pick (routing varies it per task) for the status line
      // and the turn ledger — not a re-classification with an empty prompt.
      routedRef.current = { model: choice.model, reason: choice.reason };
      setLastPick({ model: choice.model, reason: choice.reason });
      onEvent({ type: "model-pick", model: choice.model.label, provider: choice.model.provider, reason: choice.reason });
      onEvent({ type: "phase", label: "building context", detail: choice.model.label, state: "running" });
      // The Context Engine projects the full history into a bounded, model-aware
      // working set to SEND; the returned ledger stays the full source of truth.
      const userContent = imageContent(prompt, activeImagesRef.current);
      const { system, messages: ctx } = buildContext({ history: messages, userText: prompt, userContent, model: choice.model, plan });
      // Pick the active account for this model's provider and inject its creds.
      // No account → env-default for users who have opted to keep keys in env.
      // Durable accounts remain the preferred onboarding path.
      const account = accountResolver.pick(choice.model.provider);
      const creds = account ? await resolveCreds(account) : undefined;
      usedAccountRef.current = account?.id ?? null;
      cliMetaRef.current = null;
      if (account) markUsed(account.id);
      const _effortRaw = normalizeEffort(effortRef.current, effortLevels(choice.model));
      if (_effortRaw === null && effortRef.current !== "medium") {
        const supported = effortLevels(choice.model);
        const { level: nearest } = clampEffort(effortRef.current, supported);
        const hint = supported.length ? ` — try /effort ${nearest}` : "";
        throw new Error(`effort "${effortRef.current}" is not supported by ${choice.model.label} (supports: ${supported.join(", ") || "none"}${hint})`);
      }
      const modelEffort = _effortRaw ?? undefined;
      const r = await runTask({ model: choice.model, messages: ctx, onEvent, signal, plan, system, creds, effort: modelEffort });
      // r.messages = the sent context + the newly produced turn. Rebuild msgRef as
      // FULL history + the user message + only the new messages (never the curated
      // projection), and sanitize so an interrupted turn can't leave a dangling
      // tool_use that 400s the next request.
      const produced = r.messages.slice(ctx.length);
      const imageNote = activeImagesRef.current.length
        ? `\n\n[Attached images: ${activeImagesRef.current.map((img) => basename(img.path)).join(", ")}]`
        : "";
      const ledger = sanitizeToolPairs([...messages, { role: "user", content: prompt + imageNote }, ...produced]);
      return { messages: ledger, usage: r.usage };
    },
    [],
  );

  // Summarize older turns (cheap model via the selector seam — kind:"summarize")
  // and rewrite msgRef in place. The visible transcript (items) is untouched;
  // only the model's working context shrinks. Returns a status line for a notice.
  const compactNow = useCallback(
    async (keepRecent: number, signal?: AbortSignal): Promise<string> => {
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
    [],
  );

  const MODE_NOTE: Record<"normal" | "auto-accept" | "plan", string> = {
    normal: "normal mode — I'll ask before writes, edits, and shell",
    "auto-accept": "auto-accept edits — file writes/edits apply without asking (shell still gated)",
    plan: "plan mode — read-only; I'll propose a plan before changing anything",
  };
  const setModeTo = (next: "normal" | "auto-accept" | "plan") => {
    modeRef.current = next;
    setMode(next);
    notice(MODE_NOTE[next]);
  };
  // Shift+Tab cycles normal → auto-accept → plan → normal (Claude Code style).
  const cycleMode = () => {
    const order = ["normal", "auto-accept", "plan"] as const;
    setModeTo(order[(order.indexOf(modeRef.current) + 1) % order.length]!);
  };
  // /plan jumps straight to/from plan mode (toggle), independent of the cycle.
  const togglePlan = () => setModeTo(modeRef.current === "plan" ? "normal" : "plan");

  const effortRef = useRef(effort);
  effortRef.current = effort;
  // Picking an API model implies leaving any active CLI subscription, because a
  // subscription account owns the whole turn through its vendor binary.
  const leaveSubscription = (): string => {
    if (!activeCliRef.current) return "";
    activeCliRef.current = null;
    cliSessionRef.current = undefined;
    setActiveCliModelId(undefined);
    setActiveCli(null);
    updatePrefs({ activeAccount: null });
    return " (left the subscription)";
  };
  // Apply effort clamping when switching to a model with different effort support.
  // Returns a suffix to append to the model-switch notice, or "" if no change.
  const applyEffortClamp = (allowed: string[]): string => {
    const { level, clamped } = clampEffort(effortRef.current, allowed);
    if (!clamped) return "";
    const prev = effortRef.current;
    effortRef.current = level;
    setEffortState(level);
    if (!allowed.length) return ` — effort reset to ${level} (no reasoning support)`;
    return ` — effort clamped: ${prev} → ${level} (${prev} not supported)`;
  };

  const setEffort = (raw: string) => {
    const target = effortTarget();
    if (!target?.efforts.length) {
      notice("the active model does not expose reasoning efforts");
      return;
    }
    const level = normalizeEffort(raw, target.efforts);
    if (!level) {
      notice(`${target.label} supports: ${target.efforts.join(", ")}`);
      return;
    }
    effortRef.current = level;
    setEffortState(level);
    notice(`effort: ${level} — ${target.label}`);
  };

  // Hand the terminal to an interactive child (e.g. `claude auth login`'s OAuth
  // flow): drop raw mode + leave the alt-screen so the child owns the TTY,
  // run it synchronously (Ink is frozen meanwhile, so it can't steal stdin), then
  // restore our screen. Returns the child's exit code (or null if it couldn't run).
  const runInteractive = (cmd: string, cmdArgs: string[], env?: Record<string, string>): number | null => {
    try {
      setRawMode?.(false);
      if (process.env.GEARBOX_MOUSE !== "0") process.stdout.write("\x1b[?1006l\x1b[?1002l\x1b[?1000l"); // mouse off
      if (fullscreen) process.stdout.write("\x1b[?1049l"); // leave alt-screen
      process.stdout.write("\x1b[?2004l\x1b[?25h"); // bracketed paste off, cursor on
      process.stdout.write(`\n→ running \`${cmd} ${cmdArgs.join(" ")}\` — follow the prompts…\n\n`);
      const r = nodeSpawnSync(cmd, cmdArgs, { stdio: ["inherit", "inherit", "inherit"], ...(env ? { env } : {}) });
      return r.status ?? 0;
    } catch {
      return null;
    } finally {
      if (fullscreen) process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");
      if (process.env.GEARBOX_MOUSE !== "0") process.stdout.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h");
      process.stdout.write("\x1b[?2004l\x1b[?25l");
      setRawMode?.(true);
    }
  };

  const runTurn = useCallback(
    async (prompt: string) => {
      setVerb(nextVerb());
      activeImagesRef.current = [];
      let { text: modelPrompt, attached } = expandMentions(prompt);
      if (attached.length) notice(`attached ${attached.length} file${attached.length > 1 ? "s" : ""}: ${attached.join(", ")}`);
      const imagePaths = uniq([...chipImagePathsIn(modelPrompt), ...imagePathsInText(modelPrompt)]);
      let displayPrompt = prompt;
      for (const path of imagePaths) {
        const marker = imageMarkerFor(path);
        modelPrompt = replaceImagePathWithMarker(modelPrompt, path, marker);
        displayPrompt = replaceImagePathWithMarker(displayPrompt, path, marker);
      }
      const images: ImageAttachment[] = [];
      for (const path of imagePaths) {
        try {
          images.push(loadImageAttachment(path));
        } catch (e: any) {
          notice(`couldn't attach ${basename(path)}: ${(e?.message ?? String(e)).split("\n")[0]}`);
        }
      }
      activeImagesRef.current = images;
      if (images.length) {
        const names = images.map((img) => imageMarkerFor(img.path)).join(", ");
        notice(`attached ${images.length} image${images.length === 1 ? "" : "s"}: ${names}`);
      }
      echo(displayPrompt);
      lastPromptRef.current = displayPrompt;
      const urls = urlsInText(modelPrompt);
      if (urls.length) {
        const fetched: string[] = [];
        for (const url of urls) {
          try {
            const page = await fetchUrlText(url);
            fetched.push(`=== ${page.url}${page.title ? ` · ${page.title}` : ""} ===\n${page.text}`);
          } catch (e: any) {
            notice(`couldn't fetch ${url}: ${(e?.message ?? String(e)).split("\n")[0]}`);
          }
        }
        if (fetched.length) {
          notice(`fetched ${fetched.length} URL${fetched.length === 1 ? "" : "s"} for context`);
          modelPrompt += `\n\n# FETCHED URL CONTEXT\n${fetched.join("\n\n")}`;
        }
      }
      setBusy(true);
      setSuggestion(null);
      const turnStart = Date.now();
      outCharsRef.current = 0;
      if (lingerRef.current) clearTimeout(lingerRef.current);
      setLinger(false);
      setMascotState("thinking");
      atBottomRef.current = true; // follow the live output
      if (!sessionRef.current.title) sessionRef.current.title = prompt.slice(0, 80);
      curAsstRef.current = null;
      const ac = new AbortController();
      abortRef.current = ac;
      const toolMap = new Map<string, number>();
      const pendingToolStreams = new Map<number, { arg?: string; delta: string; lines: number }>();
      let toolFlushTimer: ReturnType<typeof setTimeout> | null = null;
      const changedFiles = new Set<string>();
      const checks: string[] = [];
      const failures: string[] = [];
      let hadError = false;
      const finishAssistant = () => {
        const id = curAsstRef.current;
        if (id == null) return;
        setItems((prev) => prev.map((i) => (i.id === id && i.kind === "assistant" ? { ...i, done: true } : i)));
        curAsstRef.current = null;
      };
      const appendToolOutput = (toolId: number | undefined, text: string) => {
        if (!text) return;
        setItems((prev) => {
          const fallback = toolId ?? [...prev].reverse().find((i) => i.kind === "tool" && i.status === "running" && i.name === "run_shell")?.id;
          return prev.map((i) => {
            if (i.id !== fallback || i.kind !== "tool") return i;
            const lines = (text.match(/\n/g) || []).length + (text && !text.endsWith("\n") ? 1 : 0);
            return {
              ...i,
              outputTail: ((i.outputTail ?? "") + text).slice(-3000),
              outputLines: (i.outputLines ?? 0) + lines,
            };
          });
        });
      };
      const flushToolStreams = () => {
        if (toolFlushTimer) {
          clearTimeout(toolFlushTimer);
          toolFlushTimer = null;
        }
        if (!pendingToolStreams.size) return;
        const pending = new Map(pendingToolStreams);
        pendingToolStreams.clear();
        setItems((prev) =>
          prev.map((i) => {
            if (i.kind !== "tool") return i;
            const p = pending.get(i.id);
            if (!p) return i;
            if (!p.delta) return { ...i, arg: p.arg ?? i.arg };
            const tail = ((i.stream ?? "") + p.delta).slice(-2400);
            return { ...i, arg: p.arg ?? i.arg, stream: tail, streamCount: (i.streamCount ?? 0) + p.lines };
          }),
        );
      };
      const queueToolStream = (toolId: number | undefined, arg?: string, delta?: string) => {
        if (toolId == null) return;
        const prev = pendingToolStreams.get(toolId) ?? { delta: "", lines: 0 };
        const text = delta ?? "";
        pendingToolStreams.set(toolId, {
          arg: arg ?? prev.arg,
          delta: prev.delta + text,
          lines: prev.lines + (text.match(/\n/g) || []).length,
        });
        if (!toolFlushTimer) toolFlushTimer = setTimeout(flushToolStreams, 45);
      };

      const onEvent: OnEvent = (e) => {
        if (e.type === "model-pick") {
          push({ kind: "model", id: idRef.current++, model: e.model, provider: e.provider, reason: e.reason });
        } else if (e.type === "phase") {
          push({ kind: "phase", id: idRef.current++, label: e.label, detail: e.detail, state: e.state ?? "running" });
        } else if (e.type === "text") {
          setMascotState("streaming");
          outCharsRef.current += e.text.length;
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
          finishAssistant();
          const id = idRef.current++;
          toolMap.set(e.id, id);
          setItems((prev) => [...prev, { kind: "tool", id, callId: e.id, name: e.name, arg: e.arg, status: "running", summary: "", startedAt: Date.now() }]);
        } else if (e.type === "tool-stream") {
          const id = toolMap.get(e.id);
          queueToolStream(id, e.arg, e.delta);
        } else if (e.type === "tool-output") {
          const id = e.id ? toolMap.get(e.id) : undefined;
          appendToolOutput(id, e.text);
        } else if (e.type === "tool-end") {
          setMascotState("thinking"); // back to reasoning until the next text/tool
          flushToolStreams();
          const id = toolMap.get(e.id);
          const endedAt = Date.now();
          setItems((prev) => prev.map((i) => {
            if (i.id !== id || i.kind !== "tool") return i;
            const p = firstPath(i.arg);
            const preview = e.ok && p && isWriteLikeTool(i.name) ? filePreview(p) : null;
            if (isWriteLikeTool(i.name) && e.ok) {
              if (p) changedFiles.add(p);
            }
            if (!e.ok) failures.push(`${i.name}: ${e.summary}`);
            return {
              ...i,
              status: e.ok ? "ok" : "err",
              summary: e.summary,
              diff: e.diff,
              stream: undefined,
              endedAt,
              durationMs: i.startedAt ? endedAt - i.startedAt : undefined,
              ...(preview ? { preview: preview.text, previewLines: preview.lines, previewLang: preview.lang } : {}),
            };
          }));
        } else if (e.type === "verification") {
          checks.push(e.command);
          if (!e.ok) failures.push(`${e.command}: ${e.summary}`);
          push({ kind: "verification", id: idRef.current++, command: e.command, ok: e.ok, summary: e.summary });
        } else if (e.type === "preference-suggestion") {
          push({ kind: "preference", id: idRef.current++, text: e.text, acceptCommand: e.acceptCommand });
        } else if (e.type === "error") {
          hadError = true;
          failures.push(e.message);
          setMascotState("error");
          finishAssistant();
          push({ kind: "error", id: idRef.current++, text: friendlyError(e.message) });
        } else if (e.type === "done") {
          finishAssistant();
          if (e.usage.inputTokens > 0) setLastInput(e.usage.inputTokens);
          setTokens((t) => t + e.usage.inputTokens + e.usage.outputTokens);
        }
      };

      try {
        const r = await (runner ?? defaultRunner)({ prompt: modelPrompt, messages: msgRef.current, onEvent, selector: selectorRef.current, signal: ac.signal });
        msgRef.current = r.messages;
        if (!hadError && !ac.signal.aborted && changedFiles.size && checks.length === 0) {
          const commands = detectVerificationCommands(process.cwd(), [...changedFiles]);
          if (commands.length) {
            const results = await runVerification(commands, { onEvent, signal: ac.signal });
            if (results.some((res) => !res.ok)) hadError = true;
          } else {
            onEvent({ type: "phase", label: "verification skipped", detail: "no test/build/typecheck command detected", state: "err" });
          }
        }
        // Record the turn's model + usage (routing/cost data; per-turn so the
        // router can vary the model later without changing this shape).
        // The model that actually ran this turn (set by defaultRunner). Falls
        // back to a fresh select only if a custom runner bypassed defaultRunner.
        let modelId = activeCliRef.current?.id ?? routedRef.current?.model.id;
        if (!modelId) {
          try {
            modelId = selectorRef.current.select({ prompt: lastPromptRef.current ?? "" }).model.id;
          } catch {
            modelId = "unknown";
          }
        }
        sessionRef.current.turns.push({ model: modelId, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, at: Date.now() });
        // Per-account spend ledger (ACCOUNT pillar): real cost when the provider
        // reports it (claude CLI), else an estimate from token usage × list price.
        const acctId = usedAccountRef.current ?? modelId;
        const cm = cliMetaRef.current;
        const cost = cm?.costUSD ?? estimateCost([{ model: modelId, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens }]);
        recordUsage({ accountId: acctId, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, costUSD: cost, estimated: cm?.costUSD == null });
        if (cm?.rates?.length) recordRateLimits(acctId, cm.rates);
        // Auto-compact: once the history approaches the budget, summarize old
        // turns (cheap delegated model) so the next turns stay bounded without
        // losing the gist. Best-effort and skipped on interrupt.
        if (!ac.signal.aborted) {
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
        activeImagesRef.current = [];
        flushToolStreams();
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
          const changed = uniq([...changedFiles]);
          const doneChecks = uniq(checks);
          const failed = uniq(failures).slice(0, 4);
          const next = failed.length ? "/retry" : changed.length && !doneChecks.length ? "run tests" : changed.length ? "commit changes" : "/context";
          if (changed.length || doneChecks.length || failed.length) {
            push({ kind: "summary", id: idRef.current++, changed, checks: doneChecks, failures: failed, next });
          }
          setSuggestion(next);
          setLinger(true);
          if (lingerRef.current) clearTimeout(lingerRef.current);
          lingerRef.current = setTimeout(() => setLinger(false), 1500);
          // Nudge the user back for long turns (likely stepped away): bell + notify.
          if (Date.now() - turnStart > 8000 && notifyRef.current) {
            bell();
            notify("gearbox", hadError ? "turn finished with an error" : "turn finished");
          }
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

      // Sign in to a Claude/ChatGPT subscription through its official CLI.
      // Shared by `/account login` and the `/login` alias.
      // `/login claude` uses the system login; `/login claude <name>` adds an
      // ADDITIONAL, separately-logged-in account (its own config dir), so several
      // Claude (or Codex) subscriptions can run side by side.
      const signInCli = (which: string) => {
        const [w0, ...nameParts] = (which || "").trim().split(/\s+/);
        const w = (w0 || "").toLowerCase();
        const name = nameParts.join(" ").trim() || undefined;
        const provider = w === "codex" || w === "chatgpt" ? "codex-cli" : w === "claude" || !w ? "claude-cli" : null;
        if (!provider) {
          notice("which subscription? /account add claude work  ·  /account add codex work");
          return;
        }
        if (name && /^\[.*\]$/.test(name)) {
          notice(`replace ${name} with a real nickname, e.g. /account add ${provider === "codex-cli" ? "codex" : "claude"} work`);
          return;
        }
        const res = addCliAccount(provider, name);
        if (!res.ok || !res.account) {
          notice(res.message);
          return;
        }
        const bin = (res.account.auth as any).binary as string;
        const profile = (res.account.auth as any).loginProfile as string | undefined;
        const acctId = res.account.id;
        const shortLabel = accountName(res.account);
        const statusCmd = bin === "codex" ? "codex login status" : "claude auth status";
        const phaseId = pushPhase(`${accountLabel(res.account)} sign-in`, `checking ${statusCmd}`);
        void (async () => {
          try {
            let st = await cliAuthStatus(bin, profile);
            if (!st.loggedIn) {
              const detail = st.detail ? ` (${st.detail})` : "";
              updatePhase(phaseId, "running", `${accountLabel(res.account!)} sign-in`, `opening ${bin} ${cliLoginArgs(bin).join(" ")}${detail}`);
              // Run the vendor OAuth scoped to this account's own config dir.
              const code = runInteractive(bin, cliLoginArgs(bin), subscriptionEnv(bin, profile));
              if (code == null) {
                updatePhase(phaseId, "err", `${accountLabel(res.account!)} sign-in`, `couldn't launch ${bin} ${cliLoginArgs(bin).join(" ")}; run it in a terminal, then try again`);
                return;
              }
              st = await cliAuthStatus(bin, profile);
              if (!st.loggedIn) {
                const retryDetail = st.detail ? ` ${st.detail}.` : "";
                updatePhase(phaseId, "err", `${accountLabel(res.account!)} sign-in`, `didn't complete.${retryDetail} Run ${bin} ${cliLoginArgs(bin).join(" ")}, then /account add ${bin === "codex" ? "codex" : "claude"}${name ? " " + name : ""}`);
                return;
              }
            }
            const signed = st.identity ? { key: st.identity, label: st.identityLabel ?? st.detail, checkedAt: Date.now() } : undefined;
            if (signed) {
              for (const candidate of listAccounts().filter((a) => a.id !== acctId && a.exec === "cli" && (a.auth as any).binary === bin)) {
                let key = candidate.identity?.key ?? accountStatusCacheRef.current[candidate.id]?.identity;
                if (!key) {
                  const other = await cliAuthStatus(bin, (candidate.auth as any).loginProfile);
                  accountStatusCacheRef.current[candidate.id] = { signedIn: other.loggedIn, detail: other.detail, identity: other.identity };
                  if (other.identity) {
                    key = other.identity;
                    putAccount({ ...candidate, identity: { key, label: other.identityLabel ?? other.detail, checkedAt: Date.now() } });
                  }
                }
                if (key === signed.key) {
                  await removeAccount(acctId);
                  updatePhase(phaseId, "err", `${accountLabel(candidate)} already signed in`, `same identity${signed.label ? `: ${signed.label}` : ""}. Use /account ${accountSlug(candidate)}`);
                  return;
                }
              }
              putAccount({ ...res.account!, identity: signed });
              accountStatusCacheRef.current[acctId] = { signedIn: true, detail: st.detail, identity: signed.key };
            } else {
              accountStatusCacheRef.current[acctId] = { signedIn: true, detail: st.detail };
            }
            activeCliRef.current = { id: acctId, binary: bin, profile };
            cliSessionRef.current = undefined;
            setLastPick(null);
            setActiveCli({ id: acctId, label: shortLabel });
            updatePrefs({ activeAccount: acctId }); // restore this subscription next launch
            updatePhase(phaseId, "ok", `${accountLabel(res.account!)} active`, `using ${bin}${st.detail ? `; ${st.detail}` : ""}. Own tools/permissions; /account off returns to API routing`);
          } catch (e: any) {
            updatePhase(phaseId, "err", `${accountLabel(res.account!)} sign-in`, e?.message ?? String(e));
          }
        })();
      };

      // Every command runs inside this boundary: a bug in any handler becomes a
      // single clean notice, never a raw stack dumped over the UI or a crash.
      try {
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
          routedRef.current = null;
          sessionRef.current = { id: newSessionId(), createdAt: Date.now(), title: "", turns: [] };
          notice("started a fresh conversation");
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
        case "effort": {
          echo(text);
          if (arg.trim()) {
            setEffort(arg);
          } else {
            const target = effortTarget();
            notice(target?.efforts.length ? `effort: ${effortRef.current} — ${target.label} supports ${target.efforts.join(", ")}` : "the active model does not expose reasoning efforts");
          }
          return;
        }
        case "copy": {
          echo(text);
          const last = [...itemsRef.current].reverse().find((i) => i.kind === "assistant");
          if (last && last.kind === "assistant" && last.text) {
            copyToClipboard(last.text);
            notice("copied last reply to clipboard");
          } else notice("nothing to copy yet");
          return;
        }
        case "export": {
          echo(text);
          const file = arg || "gearbox-transcript.md";
          if (!itemsRef.current.length) {
            notice("nothing to export yet");
            return;
          }
          void fsWriteFile(file, transcriptMarkdown(itemsRef.current))
            .then(() => notice(`exported transcript → ${file}`))
            .catch((e: any) => notice(`couldn't write ${file}: ${e?.message ?? String(e)}`));
          return;
        }
        case "keys":
          echo(text);
          notice(KEYS_HELP);
          return;
        case "vim": {
          echo(text);
          const on = vimRef.current === "off";
          setVim(on ? "insert" : "off");
          updatePrefs({ vim: on });
          notice(on ? "vim mode on — esc for normal, i to insert" : "vim mode off");
          return;
        }
        case "config": {
          echo(text);
          const [key, val] = arg.split(/\s+/);
          const p = loadPrefs();
          if (!key) {
            notice(
              `settings (saved in ~/.gearbox/prefs.json):\n` +
                `  vim     ${p.vim ? "on" : "off"}         vim keys in the composer\n` +
                `  notify  ${p.notify === false ? "off" : "on"}          desktop ping when a long turn finishes\n` +
                `  inline  ${p.fullscreen === false ? "on" : "off"}         terminal scrollback instead of fixed bottom input (restart to apply)\n` +
                `  change one: /config <vim|notify|inline> <value>`,
            );
            return;
          }
          const on = /^(on|true|yes|1)$/i.test(val ?? "");
          if (key === "vim") {
            setVim(on ? "insert" : "off");
            updatePrefs({ vim: on });
            notice(on ? "vim mode on — esc for normal, i to insert" : "vim mode off");
          } else if (key === "inline") {
            updatePrefs({ fullscreen: !on });
            notice(`inline mode ${on ? "on" : "off"} — restart gearbox to apply`);
          } else if (key === "notify") {
            notifyRef.current = on;
            updatePrefs({ notify: on });
            notice(`notifications ${on ? "on" : "off"}`);
          } else {
            notice("settings: vim · notify · inline");
          }
          return;
        }
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
          if (!arg || arg.toLowerCase() === "all") {
            const routing = selectorRef.current instanceof RoutingSelector;
            const activeSub = activeCliRef.current;
            const mode = activeSub
              ? `now: ${activeSub.binary} subscription${activeCliModelRef.current ? ` · ${cliModelLabel(activeCliModelRef.current)}` : ""} — /account off for API routing`
              : routing ? "now: routing on — Gearbox picks per task" : `now: pinned to ${currentId ?? "one model"} — /model auto to route`;
            const list = activeSub ? formatCliModelList(activeSub.binary, activeCliModelRef.current ?? null) : formatModelList(currentId, arg.toLowerCase() === "all");
            notice(list + `\n\n  ${mode}`);
            return;
          }
          if (arg.toLowerCase() === "auto" || arg.toLowerCase() === "route") {
            if (activeCliRef.current) {
              setActiveCliModelId(undefined);
              notice(`subscription model cleared — ${activeCliRef.current.binary} will use its default. /account off for API routing`);
              return;
            }
            const left = leaveSubscription();
            setSelector(new RoutingSelector());
            setLastPick(null);
            routedRef.current = null;
            updatePrefs({ pinnedModel: undefined }); // remember: routing, across sessions
            notice("routing on — Gearbox now picks the model per task (the cheapest that can do the job)" + left);
            return;
          }
          {
            const cli = activeCliRef.current;
            if (cli) {
              // If the query contains a digit (version-specific like "sonnet-4.6", "gpt-4o"),
              // try the API registry first — versioned names are API-specific, not subscription
              // tier shortcuts. Subscription shortcuts ("sonnet", "haiku", "opus") have no digits.
              const looksVersioned = /\d/.test(arg);
              if (looksVersioned) {
                const r = resolveModelSwitch(arg);
                if (r.ok && r.modelId) {
                  const left = leaveSubscription();
                  setSelector(new FixedSelector(r.modelId));
                  setLastPick(null);
                  routedRef.current = null;
                  updatePrefs({ pinnedModel: r.modelId });
                  const newSpec2 = findModel(r.modelId);
                  const effortSuffix2 = applyEffortClamp(newSpec2 ? effortLevels(newSpec2) : []);
                  notice(`${r.message} — pinned (left subscription).${left}${effortSuffix2}`);
                  const kind = classify(lastPromptRef.current ?? "").replace("code", "code") as PreferenceKind;
                  push({ kind: "preference", id: idRef.current++, text: `Remember ${r.modelId} for ${kind} tasks?`, acceptCommand: `/prefer ${kind} ${r.modelId}` });
                  return;
                }
              }
              const cr = resolveCliModel(cli.binary, arg);
              if (!cr.ok) {
                // Not a subscription model — try the full API registry (e.g. /model haiku while on a subscription).
                const r = resolveModelSwitch(arg);
                if (r.ok && r.modelId) {
                  const left = leaveSubscription();
                  setSelector(new FixedSelector(r.modelId));
                  setLastPick(null);
                  routedRef.current = null;
                  updatePrefs({ pinnedModel: r.modelId });
                  const newSpec2 = findModel(r.modelId);
                  const effortSuffix2 = applyEffortClamp(newSpec2 ? effortLevels(newSpec2) : []);
                  notice(`${r.message} — pinned (left subscription).${left}${effortSuffix2}`);
                  const kind = classify(lastPromptRef.current ?? "").replace("code", "code") as PreferenceKind;
                  push({ kind: "preference", id: idRef.current++, text: `Remember ${r.modelId} for ${kind} tasks?`, acceptCommand: `/prefer ${kind} ${r.modelId}` });
                  return;
                }
                notice(cr.message);
                return;
              }
              setActiveCliModelId(cr.modelId);
              const newCliModel = cliModelChoices(cli.binary).find((m) => m.id === cr.modelId);
              const effortSuffix = applyEffortClamp(newCliModel?.efforts ?? []);
              notice(`subscription model → ${cr.label} — using ${cli.binary}; tools and permissions still owned by the subscription${effortSuffix}`);
              return;
            }
            const r = resolveModelSwitch(arg);
            if (r.ok && r.modelId) {
              const left = leaveSubscription();
              setSelector(new FixedSelector(r.modelId));
              setLastPick(null);
              routedRef.current = null;
              updatePrefs({ pinnedModel: r.modelId }); // persist the pin across sessions
              const newSpec = findModel(r.modelId);
              const effortSuffix = applyEffortClamp(newSpec ? effortLevels(newSpec) : []);
              notice(`${r.message} — pinned (persists across sessions). /model auto to route per task again.${left}${effortSuffix}`);
              const kind = classify(lastPromptRef.current ?? "").replace("code", "code") as PreferenceKind;
              push({ kind: "preference", id: idRef.current++, text: `Remember ${r.modelId} for ${kind} tasks?`, acceptCommand: `/prefer ${kind} ${r.modelId}` });
            } else {
              notice(r.message);
            }
          }
          return;
        case "prefer": {
          echo(text);
          const [kindRaw, modelRaw] = arg.split(/\s+/);
          const allowed = new Set(["code", "search", "summarize", "classify", "plan", "chat"]);
          if (!kindRaw || !modelRaw || !allowed.has(kindRaw)) {
            notice("usage: /prefer <code|plan|search|summarize|classify|chat> <model>");
            return;
          }
          const r = resolveModelSwitch(modelRaw);
          if (!r.ok || !r.modelId) {
            notice(r.message);
            return;
          }
          const pref = confirmRoutingPreference({ kind: kindRaw as PreferenceKind, modelId: r.modelId, repo: process.cwd() });
          setSelector((s) => (s instanceof RoutingSelector ? new RoutingSelector() : s));
          notice(`remembered: prefer ${pref.modelId} for ${pref.kind} tasks`);
          return;
        }
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
            notice("no model available — add a provider first\n\n" + onboardingSummary(onboardingState));
            return;
          }
          const { sections } = buildContext({ history: msgRef.current, userText: lastPromptRef.current || "(your next message)", model: m, plan: modeRef.current === "plan" });
          push({ kind: "context", id: idRef.current++, view: buildContextView(sections, m.contextWindow, process.cwd()) });
          return;
        }
        case "onboard": {
          echo(text);
          if (arg.trim().toLowerCase() === "providers") {
            const rows = featuredApiKeyProviders().map((p) => `  ${p.id.padEnd(18)} ${p.label.padEnd(24)} ${p.envVars[0] ?? ""}`.trimEnd());
            notice(["providers you can add with /account add <provider> <api-key>", ...rows, "", "Aliases work for common names, e.g. gemini -> google, grok -> xai, kimi -> moonshot."].join("\n"));
          } else {
            notice(onboardingSummary(onboardingState));
          }
          return;
        }
        case "mcp": {
          echo(text);
          const parts = shellSplit(arg);
          const sub = (parts[0] ?? "list").toLowerCase();
          if (sub === "list" || sub === "servers") {
            notice(formatMcpConfigList());
            return;
          }
          if (sub === "tools") {
            notice("checking MCP servers…");
            void mcpToolSummary().then(notice).catch((e: any) => notice(`couldn't list MCP tools: ${e?.message ?? String(e)}`));
            return;
          }
          if (sub === "paths") {
            notice(mcpConfigPaths().join("\n"));
            return;
          }
          if (sub === "add") {
            const global = parts[1] === "--global";
            const offset = global ? 2 : 1;
            const serverName = parts[offset] ?? "";
            const command = parts[offset + 1] ?? "";
            const commandArgs = parts.slice(offset + 2);
            try {
              notice(addMcpServer(serverName, command, commandArgs, { scope: global ? "global" : "project" }) + "\nRestarting is not required; new turns can use the tools.");
            } catch (e: any) {
              notice(`${e?.message ?? String(e)}\nExample: /mcp add github npx -y @modelcontextprotocol/server-github`);
            }
            return;
          }
          if (sub === "remove" || sub === "rm") {
            const global = parts[1] === "--global";
            const name = parts[global ? 2 : 1] ?? "";
            notice(removeMcpServer(name, { scope: global ? "global" : undefined }));
            return;
          }
          notice(
            "MCP commands:\n" +
              "  /mcp list\n" +
              "  /mcp tools\n" +
              "  /mcp add <name> <command> [args...]\n" +
              "  /mcp add --global <name> <command> [args...]\n" +
              "  /mcp remove <name>\n" +
              "  /mcp paths",
          );
          return;
        }
        // Everything account-related, addressed by NUMBER (never an id):
        //   /account              → numbered list
        //   /account <n>          → switch to account #n
        //   /account add …        → sign in (claude/codex) or paste an API key
        //   /account remove <n>   → remove account #n
        //   /account off          → leave the active subscription
        case "accounts":
        case "account": {
          echo(text);
          const parts = arg.split(/\s+/).filter(Boolean);
          const subL = (parts[0] || "").toLowerCase();
          const all = listAccounts();
          const activeId = activeCliRef.current?.id ?? null;
          const withDuplicateMarks = (accounts: typeof all, statuses: Record<string, { signedIn?: boolean; detail?: string; duplicateOf?: string; identity?: string }>) => {
            const seen = new Map<string, string>();
            for (const a of accounts) {
              const st = statuses[a.id];
              if (!st?.identity || st.signedIn === false) continue;
              const first = seen.get(st.identity);
              if (first) st.duplicateOf = accountName(accounts.find((x) => x.id === first) ?? a);
              else seen.set(st.identity, a.id);
            }
            return statuses;
          };
          const checkCliAccounts = async (accounts: typeof all) => {
            const statuses: Record<string, { signedIn?: boolean; detail?: string; duplicateOf?: string; identity?: string }> = { ...accountStatusCacheRef.current };
            await Promise.all(accounts.filter((a) => a.exec === "cli").map(async (a) => {
              const bin = (a.auth as any).binary as string;
              const profile = (a.auth as any).loginProfile as string | undefined;
              const st = await cliAuthStatus(bin, profile);
              statuses[a.id] = { signedIn: st.loggedIn, detail: st.detail, identity: st.identity };
            }));
            accountStatusCacheRef.current = withDuplicateMarks(accounts, statuses);
            return accountStatusCacheRef.current;
          };
          const showList = () => {
            void (async () => {
              try {
                const fresh = listAccounts();
                const statuses = await checkCliAccounts(fresh);
                pushAccounts(buildAccountView(fresh, activeCliRef.current?.id ?? null, importableEnvCreds(), statuses));
              } catch (e: any) {
                notice(`couldn't check subscription accounts — ${e?.message ?? String(e)}`);
                pushAccounts(buildAccountView(listAccounts(), activeCliRef.current?.id ?? null, importableEnvCreds(), accountStatusCacheRef.current));
              }
            })();
          };
          const byNumber = (s?: string) => {
            const n = Number(s);
            return Number.isInteger(n) && n >= 1 && n <= all.length ? all[n - 1] : undefined;
          };
          // Make an account active. cli → run through its binary; api → set the
          // provider default and drop any active subscription so API/routing runs.
          const activate = (a: (typeof all)[number]) => {
            if (a.exec === "cli") {
              const bin = (a.auth as any).binary as string;
              const profile = (a.auth as any).loginProfile as string | undefined;
              const phaseId = pushPhase(`${accountLabel(a)} sign-in`, `checking ${bin === "codex" ? "codex login status" : "claude auth status"}`);
              void (async () => {
                try {
                  const st = await cliAuthStatus(bin, profile);
                  if (!st.loggedIn) {
                    updatePhase(phaseId, "err", `${accountLabel(a)} sign-in`, `not signed in${st.detail ? `; ${st.detail}` : ""}. Run /account add ${bin === "codex" ? "codex" : "claude"}${accountName(a).includes("(") ? " " + accountName(a).replace(/^.*\((.*)\).*$/, "$1") : ""}`);
                    accountStatusCacheRef.current[a.id] = { signedIn: false, detail: st.detail };
                    return;
                  }
                  if (st.identity) {
                    putAccount({ ...a, identity: { key: st.identity, label: st.identityLabel ?? st.detail, checkedAt: Date.now() } });
                    accountStatusCacheRef.current[a.id] = { signedIn: true, detail: st.detail, identity: st.identity };
                  } else {
                    accountStatusCacheRef.current[a.id] = { signedIn: true, detail: st.detail };
                  }
                  activeCliRef.current = { id: a.id, binary: bin, profile };
                  if (activeCliModelRef.current && !cliSupportsModel(bin, activeCliModelRef.current)) setActiveCliModelId(undefined);
                  cliSessionRef.current = undefined;
                  setActiveCli({ id: a.id, label: accountName(a) });
                  updatePrefs({ activeAccount: a.id });
                  updatePhase(phaseId, "ok", `switched to ${accountLabel(a)}`, st.detail);
                } catch (e: any) {
                  updatePhase(phaseId, "err", `${accountLabel(a)} sign-in`, e?.message ?? String(e));
                }
              })();
            } else {
              activeCliRef.current = null;
              setActiveCliModelId(undefined);
              setActiveCli(null);
              setDefaultAccount(a.provider, a.id);
              updatePrefs({ activeAccount: null });
              notice(`switched to ${accountLabel(a)}`);
            }
          };

          if (!subL) {
            showList();
            return;
          }
          if (subL === "off") {
            activeCliRef.current = null;
            setActiveCliModelId(undefined);
            cliSessionRef.current = undefined;
            setActiveCli(null);
            updatePrefs({ activeAccount: null });
            notice("left the subscription — back to your API keys");
            return;
          }
          // Switch by number: `/account 2`.
          const numbered = byNumber(subL);
          if (numbered) {
            activate(numbered);
            return;
          }
          // A number that's out of range (vs. a non-number, which may be a subcommand).
          if (/^\d+$/.test(subL)) {
            notice(all.length ? `there's no account ${subL} — pick 1–${all.length}.\n\n` + formatAccounts(all, activeId, []) : "no accounts yet — /account add to add one");
            return;
          }
          if (!["add", "remove", "rm", "import", "off"].includes(subL)) {
            const ref = findAccountRef(arg, all);
            if (ref.account) {
              activate(ref.account);
              return;
            }
            notice(`${ref.error}.\n\n` + formatAccounts(all, activeId, importableEnvCreds(), accountStatusCacheRef.current));
            return;
          }
          if (subL === "add") {
            const rawFirst = parts[1] ?? "";
            const first = rawFirst.toLowerCase();
            const bracketedFirst = first.match(/^\[(.*)\]$/)?.[1] ?? first;
            if (["claude/codex", "codex/claude", "claude|codex", "codex|claude"].includes(bracketedFirst)) {
              notice("choose one provider: /account add claude work  ·  /account add codex work");
              return;
            }
            // Subscription sign-in (what people try first).
            if (["claude", "codex", "chatgpt", "claude-cli", "codex-cli"].includes(bracketedFirst)) {
              const provider = bracketedFirst.startsWith("codex") || bracketedFirst === "chatgpt" ? "codex" : "claude";
              signInCli(`${provider} ${parts.slice(2).join(" ")}`.trim());
              return;
            }
            if (/^\[.*\]$/.test(rawFirst)) {
              notice("replace placeholders with real values, e.g. /account add claude work or /account add codex work");
              return;
            }
            const key = parts[1] ?? "";
            const provGiven = parts[2] ? key : "";
            const keyVal = parts[2] ?? "";
            if (!key) {
              notice(
                "add an account:\n" +
                  "  /account add claude          Claude subscription (Pro/Max)\n" +
                  "  /account add claude <name>   a 2nd Claude account, e.g. /account add claude work\n" +
                  "  /account add codex           ChatGPT subscription (Plus/Pro)\n" +
                  "  /account add codex <name>    a 2nd ChatGPT account, e.g. /account add codex work\n" +
                  "  /account add azure <foundry-endpoint> <api-key>\n" +
                  "  /account add azure <resource-name> <api-key> [api-version]\n" +
                  "  /account add openai-compat <name> <base-url> <api-key> <model> [model...]\n" +
                  "  /account add <api-key>       paste any provider key (auto-detected)\n" +
                  "  /account add <provider> <api-key>   e.g. anthropic, openai, openrouter",
              );
              return;
            }
            void (async () => {
              let res;
              if (first === "azure") {
                const resource = parts[2] ?? "";
                const azureKey = parts[3] ?? "";
                const apiVersion = parts[4];
                res = /^https?:\/\//i.test(resource) ? await addAzureFoundryAccount(resource, azureKey) : await addAzureAccount(resource, azureKey, { apiVersion });
              } else if (["openai-compat", "openai-compatible", "custom", "proxy"].includes(first)) {
                res = await addOpenAICompatAccount(parts[2] ?? "", parts[3] ?? "", parts[4] ?? "", parts.slice(5));
              } else if (catalogProvider(first)?.authKind === "openai-compat" && !catalogProvider(first)?.baseUrl && /^https?:\/\//i.test(parts[2] ?? "")) {
                res = await addOpenAICompatAccount(first, parts[2] ?? "", parts[3] ?? "", parts.slice(4));
              } else if (provGiven) res = await addApiKeyAccount(provGiven, keyVal);
              else if (detectProviderByKey(key)) res = await addByPastedKey(key);
              else {
                notice(`"${key}" isn't a recognized key. Try /account add claude, /account add codex, or paste a full API key.`);
                return;
              }
              if (!res.ok || !res.account) {
                notice(res.message);
                return;
              }
              notice(`${res.message} — testing…`);
              const t = await testAccount(res.account);
              notice(t.ok ? `✓ added · ${t.message}` : `added, but the key test failed: ${t.message}`);
            })();
            return;
          }
          if (subL === "remove" || subL === "rm") {
            const ref = findAccountRef(parts.slice(1).join(" "), all);
            const a = ref.account;
            if (!a) {
              notice(`${ref.error ?? "which account?"}\n\n` + formatAccounts(all, activeId, importableEnvCreds(), accountStatusCacheRef.current));
              return;
            }
            const wasActive = activeCliRef.current?.id === a.id;
            void removeAccount(a.id).then(() => {
              if (wasActive) {
                activeCliRef.current = null;
                setActiveCliModelId(undefined);
                setActiveCli(null);
              }
              notice(`removed ${accountLabel(a)}`);
            });
            return;
          }
          if (subL === "import") {
            void (async () => {
              const keys = importableEnvCreds();
              const cloud = importableCloudCreds();
              if (!keys.length && !cloud.length) {
                notice("nothing to import — no new provider keys or cloud creds found");
                return;
              }
              for (const c of keys) await importEnvCred(c);
              for (const c of cloud) await importCloudCred(c);
              showList();
            })();
            return;
          }
          // Anything else → show the list (so a stray arg still helps).
          notice(`didn't recognize "/account ${arg}".\n\n` + formatAccounts(all, activeId, importableEnvCreds(), accountStatusCacheRef.current));
          return;
        }
        case "login": {
          echo(text);
          signInCli(arg);
          return;
        }
        case "cost":
        case "usage": {
          echo(text);
          const accounts = listAccounts();
          const resolve = (id: string) => {
            const a = getAccount(id);
            if (a) {
              const bin = a.auth.kind === "cli" ? a.auth.binary : undefined;
              return {
                name: accountName(a),
                kind: (a.exec === "cli" ? "sub" : "api") as "sub" | "api",
                balanceExposed: a.exec !== "cli" && balanceExposed(a.provider),
                limitNote: a.exec === "cli" ? `${bin === "codex" ? "Codex" : "Claude"} CLI has not reported quota windows yet` : undefined,
              };
            }
            if (id === "unknown") return { name: "(unattributed)", kind: "api" as const };
            return { name: id, kind: "api" as const }; // a model id or env-derived label
          };
          const session = estimateCost(sessionRef.current.turns);
          // Providers that expose a remaining balance (OpenRouter, Vercel). For
          // the rest the card shows spend, synchronously.
          const withBalance = accounts.filter((a) => a.exec !== "cli" && balanceExposed(a.provider));
          if (!withBalance.length) {
            // No live fetch needed → push the complete card once. (Pushing then
            // mutating wouldn't work: a finished card commits to <Static>, which
            // never re-renders — the inline default.)
            pushUsage(buildUsageView(session, resolve, Date.now(), accounts.map((a) => a.id)));
            return;
          }
          notice("checking balances…");
          void (async () => {
            for (const a of withBalance) {
              const bal = await fetchBalance(a);
              if (bal?.remainingUSD != null) recordBalance(a.id, bal);
            }
            pushUsage(buildUsageView(session, resolve, Date.now(), accounts.map((a) => a.id))); // push ONCE, with balances in
          })();
          return;
        }
        case "compact": {
          echo(text);
          if (busyRef.current) {
            notice("busy — try /compact once the current turn finishes");
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
          echo(text);
          setBusy(true);
          setSuggestion(null);
          void (async () => {
            const id = idRef.current++;
            try {
              push({ kind: "tool", id, callId: `init:${id}`, name: "write_file", arg: "GEARBOX.md", status: "running", summary: "", startedAt: Date.now() });
              const res = writeProjectGuide(process.cwd());
              setItems((prev) => prev.map((i) => (i.id === id && i.kind === "tool" ? { ...i, status: "ok", summary: res.summary, diff: res.diff, endedAt: Date.now() } : i)));
              const commands = detectVerificationCommands(process.cwd(), ["GEARBOX.md"]);
              if (commands.length) await runVerification(commands.slice(0, 1), { onEvent: (e) => {
                if (e.type === "verification") push({ kind: "verification", id: idRef.current++, command: e.command, ok: e.ok, summary: e.summary });
                else if (e.type === "phase") push({ kind: "phase", id: idRef.current++, label: e.label, detail: e.detail, state: e.state ?? "running" });
              } });
              notice("initialized GEARBOX.md");
              persist();
            } catch (e: any) {
              setItems((prev) => prev.map((i) => (i.id === id && i.kind === "tool" ? { ...i, status: "err", summary: e?.message ?? String(e), endedAt: Date.now() } : i)));
            } finally {
              setBusy(false);
            }
          })();
          return;
        default: {
          echo(text);
          // Suggest the closest real command (typo-friendly), else point to /help.
          const near = matchCommands(`/${name}`).filter((c) => c.name !== `/${name}`)[0];
          notice(near ? `no /${name} command — did you mean ${near.name}?  (/help for all)` : `no /${name} command — type /help to see what's available`);
          return;
        }
      }
      } catch (e: any) {
        notice(`/${name} hit an error: ${(e?.message ?? String(e)).split("\n")[0]}`);
      }
    },
    [exit, runTurn, onboardingState],
  );

  const submit = useCallback(
    (value: string) => {
      let text = value.trim();
      // Expand any collapsed-paste chips back to their real text before sending.
      if (pasteStoreRef.current.size) {
        for (const [ph, full] of pasteStoreRef.current) if (text.includes(ph)) text = text.split(ph).join(full);
        pasteStoreRef.current.clear();
      }
      setEdit({ value: "", cursor: 0 });
      histIdxRef.current = null;
      if (!text) return;
      const h = historyRef.current;
      if (h[h.length - 1] !== text) h.push(text);
      appendHistory(text); // persist across runs
      if (text.startsWith("!")) {
        const cmd = text.slice(1).trim();
        echo(text);
        if (!cmd) {
          notice("run a shell command with !<command> — e.g. !git status");
          return;
        }
        const id = idRef.current++;
        const startedAt = Date.now();
        push({ kind: "tool", id, callId: `direct:${id}`, name: "run_shell", arg: cmd, status: "running", summary: "", startedAt });
        void (async () => {
          const r = await runShellStream(cmd, {
            onChunk: (c) => {
              setItems((prev) =>
                prev.map((i) => {
                  if (i.id !== id || i.kind !== "tool") return i;
                  const lines = (c.text.match(/\n/g) || []).length + (c.text && !c.text.endsWith("\n") ? 1 : 0);
                  return { ...i, outputTail: ((i.outputTail ?? "") + c.text).slice(-3000), outputLines: (i.outputLines ?? 0) + lines };
                }),
              );
            },
          });
          setItems((prev) => prev.map((i) => (i.id === id && i.kind === "tool" ? { ...i, status: r.ok ? "ok" : "err", summary: r.output.split("\n").find((l) => l.trim()) ?? "(no output)", endedAt: Date.now(), durationMs: Date.now() - startedAt, exitCode: r.exitCode } : i)));
        })();
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
      if (setupRequired) {
        echo(text);
        notice("set up a provider before sending a task\n\n" + onboardingSummary(onboardingState));
        return;
      }
      if (busyRef.current) {
        // Queue it — sent automatically when the current turn finishes.
        queueRef.current.push(text);
        setQueued([...queueRef.current]);
        notice(`queued (${queueRef.current.length}) — sends when the current turn finishes`);
        return;
      }
      void runTurn(text);
    },
    [handleCommand, runTurn, setupRequired, onboardingState],
  );

  // Drain the type-ahead queue when a turn finishes.
  useEffect(() => {
    if (busy || queueRef.current.length === 0) return;
    const next = queueRef.current.shift();
    setQueued([...queueRef.current]);
    if (next) void runTurn(next);
  }, [busy, runTurn]);

  // Rewind the last user turn back into the composer for editing, dropping that
  // turn's transcript items + model messages.
  const rewindLastTurn = () => {
    const its = itemsRef.current;
    let ui = -1;
    for (let i = its.length - 1; i >= 0; i--) if (its[i]!.kind === "user") { ui = i; break; }
    if (ui < 0) {
      notice("nothing to rewind");
      return;
    }
    const userText = (its[ui] as Extract<Item, { kind: "user" }>).text;
    setItems(its.slice(0, ui));
    const ms = msgRef.current;
    let mi = -1;
    for (let i = ms.length - 1; i >= 0; i--) if (ms[i]!.role === "user") { mi = i; break; }
    if (mi >= 0) msgRef.current = ms.slice(0, mi);
    curAsstRef.current = null;
    setEdit({ value: userText, cursor: userText.length });
    notice("rewound the last turn — edit and resend");
  };

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
    // ⌃C — interrupt a turn; else clear the composer; else "press again to quit".
    if (key.ctrl && input === "c") {
      if (busyRef.current) {
        interruptedRef.current = true;
        abortRef.current?.abort();
        return;
      }
      if (editRef.current.value) {
        setEdit({ value: "", cursor: 0 });
        return;
      }
      const now = Date.now();
      if (now - ctrlCRef.current < 1500) {
        exit();
        return;
      }
      ctrlCRef.current = now;
      notice("press ⌃C again to quit");
      return;
    }
    // Reverse-i-search (⌃R): ⌃R opens / steps to the next older match; type to
    // filter; ⏎ accepts into the composer; esc cancels.
    if (key.ctrl && input === "r") {
      const cur = searchRef.current;
      setSearch(cur ? { q: cur.q, idx: cur.idx + 1 } : { q: "", idx: 0 });
      return;
    }
    if (searchRef.current) {
      const s = searchRef.current;
      const match = searchHistory(historyRef.current, s.q, s.idx);
      if (key.escape) {
        setSearch(null);
        return;
      }
      if (key.return) {
        setSearch(null);
        if (match) setEdit({ value: match, cursor: match.length });
        return;
      }
      if (key.backspace || key.delete) {
        setSearch({ q: s.q.slice(0, -1), idx: 0 });
        return;
      }
      if (input && !key.ctrl && !key.meta && !key.tab) {
        setSearch({ q: s.q + input, idx: 0 });
        return;
      }
      return; // swallow everything else while searching
    }
    if (!busyRef.current && suggestion && !editRef.current.value && ((key.tab && !key.shift) || key.rightArrow)) {
      setEdit({ value: suggestion, cursor: suggestion.length });
      setSuggestion(null);
      return;
    }
    if (!busyRef.current) {
      const draft = editRef.current.value;
      const cursor = editRef.current.cursor;
      const mention = currentMention(draft, cursor);
      const fileMatches = mention ? matchFiles(listProjectFiles(), mention.token) : [];
      const pickerRows = commandPickerRows(draft);
      const cmdMatches = draft.startsWith("/") ? matchCommands(draft) : [];
      const activeCount = pickerRows.length || fileMatches.length || cmdMatches.length;
      const exactPickerValue = pickerRows.length === 1 && pickerRows[0]!.value.trim() === draft.trim();
      const paletteShouldOwnArrows = activeCount > 1 || (activeCount === 1 && !exactPickerValue && !isExactSlashCommand(draft));
      if (key.return && isExactSlashCommand(draft)) {
        setPaletteIndex(0);
        submit(draft.trim());
        return;
      }
      if (key.return && /^\/\S+\s+/.test(draft.trim()) && !pickerRows.length && !fileMatches.length) {
        setPaletteIndex(0);
        submit(draft.trim());
        return;
      }
      if (paletteShouldOwnArrows && (key.upArrow || key.downArrow)) {
        const delta = key.upArrow ? -1 : 1;
        setPaletteIndex((paletteIndexRef.current + delta + activeCount) % activeCount);
        return;
      }
      if (activeCount && ((key.tab && !key.shift) || key.return)) {
        const idx = Math.min(paletteIndexRef.current, activeCount - 1);
        if (pickerRows.length) {
          const value = pickerRows[idx]!.value;
          setPaletteIndex(0);
          if (key.return) submit(value);
          else setEdit({ value, cursor: value.length });
          return;
        }
        if (fileMatches.length && mention) {
          const r = completeMention(draft, mention, fileMatches[idx]!);
          setEdit({ value: r.value, cursor: r.cursor });
          setPaletteIndex(0);
          return;
        }
        if (cmdMatches.length) {
          const name = cmdMatches[idx]!.name + " ";
          setEdit({ value: name, cursor: name.length });
          setPaletteIndex(0);
          return;
        }
      }
    }
    // ? on an empty composer → shortcuts cheatsheet (still typeable mid-text).
    if (input === "?" && !editRef.current.value && !busyRef.current && !key.ctrl && !key.meta) {
      notice(KEYS_HELP);
      return;
    }
    // ⌃O — toggle full diffs / tool output (un-truncate the 16-line cap).
    if (key.ctrl && input === "o") {
      setExpandAll((x) => {
        flashStatus(x ? "collapsed long output" : "expanded full diffs and output");
        return !x;
      });
      return;
    }
    // ⌃Y — copy the last assistant reply to the clipboard (OSC 52; works over SSH).
    if (key.ctrl && input === "y") {
      const last = [...itemsRef.current].reverse().find((i) => i.kind === "assistant");
      if (last && last.kind === "assistant" && last.text) {
        copyToClipboard(last.text);
        notice("copied last reply to clipboard");
      } else notice("nothing to copy yet");
      return;
    }
    // Keyboard scroll: PgUp/PgDn page through the transcript.
    if (key.pageUp || key.pageDown) {
      scrollBy((key.pageUp ? -1 : 1) * Math.max(1, Math.floor(viewportHeightRef.current / 2)));
      return;
    }
    if (key.tab && key.shift) {
      if (!busyRef.current) cycleMode();
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
    // File drag-drop: terminals paste the dropped file's path. If it's a real
    // file, turn it into an @mention so it gets read into the prompt.
    if (!busyRef.current && input.length > 3 && !input.includes("\n")) {
      const p = sanitizeInputText(input).trim().replace(/^'|'$/g, "").replace(/\\ /g, " ");
      const abs = p.startsWith("~") ? p.replace(/^~/, process.env.HOME ?? "~") : resolve(process.cwd(), p);
      if (/[/\\.]/.test(p) && p.length < 1024 && existsSync(abs)) {
        const e = editRef.current;
        if (isImageFilePath(abs)) {
          const marker = imageMarkerFor(abs);
          setEdit({ value: e.value.slice(0, e.cursor) + marker + " " + e.value.slice(e.cursor), cursor: e.cursor + marker.length + 1 });
          flashStatus(`attached ${basename(abs)}`);
          return;
        }
        const ins = `@${p} `;
        setEdit({ value: e.value.slice(0, e.cursor) + ins + e.value.slice(e.cursor), cursor: e.cursor + ins.length });
        return;
      }
    }
    // Large paste → collapse to a chip so it doesn't flood the composer.
    if (!busyRef.current && (input.includes("\x1b[200~") || (input.length > 240 && input.includes("\n")))) {
      const clean = sanitizeInputText(input);
      const lines = clean.split("\n").length;
      if (lines > 4 || clean.length > 400) {
        const id = ++pasteIdRef.current;
        const ph = `[Pasted #${id}: ${lines} line${lines > 1 ? "s" : ""}]`;
        pasteStoreRef.current.set(ph, clean);
        const e = editRef.current;
        setEdit({ value: e.value.slice(0, e.cursor) + ph + e.value.slice(e.cursor), cursor: e.cursor + ph.length });
        return;
      }
    }
    const action = applyKey(editRef.current, input, key, vimRef.current === "off" ? undefined : { normal: vimRef.current === "normal" });
    if (busyRef.current) {
      if (action.type === "interrupt") {
        interruptedRef.current = true;
        abortRef.current?.abort();
      }
      return;
    }
    switch (action.type) {
      case "edit":
        if (suggestion) setSuggestion(null);
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
      case "interrupt": {
        // esc clears the composer; esc-esc on an empty composer rewinds the last
        // turn back into the composer for editing (Claude Code's rewind).
        const now = Date.now();
        if (!editRef.current.value && now - escRef.current < 1000) {
          escRef.current = 0;
          rewindLastTurn();
        } else {
          escRef.current = now;
          setEdit({ value: "", cursor: 0 });
        }
        break;
      }
      case "vim":
        if (action.state) setEdit(action.state);
        setVim(action.to);
        break;
      case "none":
        break;
    }
  }, { isActive: isRawModeSupported });

  const mention = currentMention(edit.value, edit.cursor);
  const fileMatches = mention ? matchFiles(listProjectFiles(), mention.token) : [];

  const welcome = items.length === 0;
  const pickerRows = commandPickerRows(edit.value);
  const cmdMatches = matchCommands(edit.value);
  const paletteCount = pickerRows.length || fileMatches.length || cmdMatches.length;
  const selectedPalette = paletteCount ? Math.min(paletteIndex, paletteCount - 1) : 0;
  const paletteKey = [
    pickerRows.length ? "picker" : fileMatches.length ? "files" : cmdMatches.length ? "commands" : "none",
    edit.value,
    ...(pickerRows.length ? pickerRows.map((r) => r.value) : fileMatches.length ? fileMatches : cmdMatches.map((c) => c.name)),
  ].join("\0");

  useEffect(() => {
    if (paletteIndexRef.current !== 0) setPaletteIndex(0);
  }, [paletteKey]);

  useEffect(() => {
    if (paletteCount === 0 && paletteIndexRef.current !== 0) {
      setPaletteIndex(0);
    } else if (paletteCount > 0 && paletteIndexRef.current >= paletteCount) {
      setPaletteIndex(paletteCount - 1);
    }
  }, [paletteCount]);

  // The transcript as a flat styled-line buffer, wrapped to the full content width.
  const lineWidth = Math.max(width - 3, 20);
  const lines = useMemo(() => itemsToLines(items, lineWidth, expandAll), [items, lineWidth, expandAll]);

  // Footer height — over-estimated so the fullscreen frame never exceeds the
  // screen (alt-screen clips overflow, so under-filling is safe, over-filling
  // clips the status bar). HEADER is the title bar (marginTop + title + rule).
  const PALETTE_ROWS = pickerRows.length ? Math.min(7, pickerRows.length) : fileMatches.length ? Math.min(5, fileMatches.length) : cmdMatches.length ? Math.min(7, cmdMatches.length) : 0;
  let footer = 2; // status line + its top margin
  footer += perm ? 9 : 3; // permission card vs composer (rule + input + marginTop)
  footer += PALETTE_ROWS;
  if (busy || linger) footer += 2; // one-line working strip (+ marginTop)
  if (busy) footer += 2; // compact current-turn activity rail
  if (mode !== "normal") footer += 2;
  if (queued.length) footer += queued.length + 1;
  if (search) footer += 1;
  if (copiedNotice) footer += 1;
  const HEADER = 3;
  const transcriptHeight = Math.max(1, rows - HEADER - footer);
  const maxScroll = Math.max(0, lines.length - transcriptHeight);
  const effScroll = atBottomRef.current ? maxScroll : Math.min(scrollTop, maxScroll);
  linesRef.current = lines;
  scrollTopLiveRef.current = effScroll;
  transcriptHeightLiveRef.current = transcriptHeight;
  viewportHeightRef.current = transcriptHeight;
  maxScrollRef.current = maxScroll;
  scrollTopRef.current = effScroll;

  // Keep scrollTop pinned to the bottom as new lines stream in (unless scrolled up).
  useEffect(() => {
    if (atBottomRef.current) setScrollTop(maxScroll);
  }, [lines.length, maxScroll]);

  const hero = (
    <Box flexDirection="column" alignItems="center">
      {setupRequired ? (
        <SetupSplash state={onboardingState} width={width} skin={ghostSkin} splashSize={splashSize} />
      ) : (
        <>
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
          {firstRunRef.current ? (
            <Box marginTop={1} flexDirection="column" alignItems="center">
              <Text color={color.faint}>new here? press <Text color={color.accent}>?</Text> for shortcuts · <Text color={color.accent}>shift+tab</Text> cycles modes · <Text color={color.accent}>⌃Y</Text> copies the last reply</Text>
              <Text color={color.faint}>/config inline on for terminal scrollback · /keys for shortcuts</Text>
            </Box>
          ) : null}
        </>
      )}
    </Box>
  );

  const paletteJsx = pickerRows.length || cmdMatches.length || fileMatches.length ? (
    <Box flexDirection="column">
      <CommandPalette draft={edit.value} selected={selectedPalette} limit={7} rows={pickerRows} width={width} />
      <FilePalette matches={fileMatches} selected={selectedPalette} limit={5} width={width} />
    </Box>
  ) : null;

  const composerJsx = perm ? (
    <PermissionPrompt req={perm} width={width} />
  ) : (
    <Composer value={edit.value} cursor={edit.cursor} selectionAnchor={edit.selectionAnchor} placeholder={setupRequired ? "add a provider with /account add <provider> <api-key>" : mode === "plan" ? "describe what to plan…" : "ask anything"} suggestion={suggestion} busy={busy} width={width} vim={vim} />
  );

  const footerJsx = (
    <>
      {busy || linger ? <Working state={mascotState} skin={ghostSkin} verb={verb} elapsed={elapsed} tps={elapsed > 0 ? Math.round(outCharsRef.current / 4 / elapsed) : 0} linger={linger && !busy} width={width} /> : null}
      {busy ? <ActivityRail items={items} width={width} /> : null}
      {queued.length ? (
        <Box paddingX={1} marginTop={1} flexDirection="column">
          {queued.map((q, i) => (
            <Text key={i} color={color.faint}>↳ queued: {q.length > 60 ? q.slice(0, 57) + "…" : q}</Text>
          ))}
        </Box>
      ) : null}
      {mode !== "normal" ? (
        <Box paddingX={1} marginTop={1}>
          <Text color={color.accent}>{glyph.notice} {mode === "plan" ? "plan mode" : "auto-accept edits"}</Text>
          <Text color={color.faint}> · {mode === "plan" ? "read-only" : "writes apply without asking; shell still gated"} · shift+tab to cycle</Text>
        </Box>
      ) : null}
      {search ? (
        <Box paddingX={1}>
          <Text color={color.accent}>(reverse-i-search)</Text>
          <Text color={color.text}>`{search.q}`: </Text>
          <Text color={color.dim}>{searchHistory(historyRef.current, search.q, search.idx) ?? (search.q ? "(no match)" : "")}</Text>
        </Box>
      ) : null}
      {copiedNotice ? (
        <Box paddingX={1}>
          <Text color={color.ok}>{glyph.notice} {copiedNotice}</Text>
        </Box>
      ) : null}
      <StatusBar model={modelLabel} branch={branch} routing={routing} subscription={subscription} yolo={yolo} ctxPct={ctxPct} tokens={tokens} cost={estimateCost(sessionRef.current.turns)} width={width} mode={mode} effort={displayEffort} online={online} />
      <Box height={PALETTE_ROWS} flexDirection="column">{paletteJsx}</Box>
      {composerJsx}
    </>
  );

  const inlineFooterJsx = (
    <>
      {paletteJsx}
      {composerJsx}
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
            <Viewport lines={lines} scrollTop={effScroll} height={transcriptHeight} width={width - 2} selection={transcriptSelection} />
          </Box>
        )}
        {footerJsx}
      </Box>
    );
  }

  // Inline (the DEFAULT): the terminal owns the screen — native selection,
  // scrollback, and wheel scroll. Finished items commit to scrollback via
  // <Static> (in Transcript); only the live tail + footer re-render.
  const banner = <Banner model={modelLabel} cwd={basename(process.cwd())} width={width} />;
  return (
    <Box flexDirection="column" width={width}>
      {welcome ? (
        <>
          {banner}
          <Box marginTop={1}>{hero}</Box>
        </>
      ) : (
        <Transcript items={items} width={width} header={banner} expandAll={expandAll} />
      )}
      {inlineFooterJsx}
    </Box>
  );
}
