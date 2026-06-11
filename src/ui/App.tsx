import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdin } from "ink";
import type { ModelMessage } from "ai";
import { Banner } from "./components/Banner.tsx";
import { Transcript } from "./components/Transcript.tsx";
import { StatusBar, statusBarHit, statusBarLayout, formatStatusCost, collapsePath } from "./components/StatusBar.tsx";
import { StatusStrip } from "./components/StatusStrip.tsx";
import { CommandPalette, type PaletteRow } from "./components/CommandPalette.tsx";
import { FilePalette } from "./components/FilePalette.tsx";
import { Composer, composerRows, composerWrapW } from "./components/Composer.tsx";
import { MascotSplash, SKINS, GHOST_LOOKS, isGhostLook, type GhostSkin, type GhostLook, type MascotState } from "./components/Mascot.tsx";
import { PermissionPrompt } from "./components/PermissionPrompt.tsx";
import { Working, workingRows } from "./components/Working.tsx";
import { Viewport, hullSelection, type ViewSelection } from "./components/Viewport.tsx";
import { itemsToLines, relPath, friendlyTool, fmtElapsed, linkAt, type Line } from "./lines.ts";
import { collapseTurn, collapseDelegateGroups } from "./collapse.ts";
import { buildRoutingLine } from "./routing-line.ts";
import { policyLabel, type SelectorKind } from "./policy.ts";
import { buildProvidersView } from "./providers-view.ts";
import { ProvidersView } from "./components/ProvidersView.tsx";
import { Masthead, MASTHEAD_ROW, TABBAR_LEFT, mastheadAccountZone } from "./components/Masthead.tsx";
import { tabBarSegments, tabBarHit, type TabRow } from "./tabbar.ts";
import { premiumRate, estimateSavings, formatPolicyString, savingsLine, turnsLeftForecast } from "./cost-tab.ts";
import { setPermissionHandler, registerPermissionHandler, registerPreMutationHook, setYolo, isYolo, type PermRequest, type PermDecision } from "../permission.ts";
import { newSessionId, saveSession, loadSession, listSessions, deleteSession, updateSessionMeta, loadHistory, appendHistory, type Session, type TurnMeta } from "../session.ts";
import { nextVerb, toolVerbFromName } from "./character.ts";
import { color, glyph, setTheme, activeTheme, THEMES } from "./theme.ts";
import { loadPrefs, updatePrefs } from "./prefs.ts";
import type { AccountView, Item } from "./types.ts";
import type { OnEvent, Usage } from "../agent/events.ts";
import { FixedSelector, type ModelSelector, type ModelChoice, type Backend } from "../model/selector.ts";
import { classifyFailure, cooldownScope, markExhausted, modelScopedKey, DEFAULT_COOLDOWN_MS, AUTH_COOLDOWN_MS } from "../model/cooldown.ts";
import { RoutingSelector, classify } from "../model/router.ts";
import { parseRateHeaders } from "../model/rate-headers.ts";
import { confirmRoutingPreference, setBudget, loadBudgets, globalPreference, type PreferenceKind } from "../model/preferences.ts";
import { effortLevels, normalizeEffort, clampEffort, type Effort } from "../model/reasoning.ts";
import { findModel, estimateCost, hasPricing, modelRegistry, providerAvailable, refreshModelsDevOverlay, type ModelSpec } from "../providers.ts";
import { Panel } from "./components/Panel.tsx";
import { clampIndex, clampScroll, panelBodyHeight, filterModelRows, appendFilter, backspaceFilter, wizardOpen, wizardPickMove, wizardPickFilter, wizardPickBackspace, wizardPickConfirm, wizardFieldEdit, wizardFieldAdvance, wizardIsComplete, wizardBack, truncate, detailOpen, detailSetDeployments, detailSetAvailableModels, detailSetError, detailSetModelsError, detailStartRefresh, detailMoveIndex, detailStartDeploy, detailDeployFilter, detailDeployBackspace, detailDeployMove, detailPickCapacity, detailCapacityMove, detailConfirmCapacity, detailNameEdit, detailNameAdvance, detailIsNameComplete, detailSetSubmitting, detailStartDelete, detailOptimisticRemove, detailBack, detailSetArmReady, type PanelState, type PanelModelRow, type PanelSessionRow, type WizardPanel, type AccountDetailPanel, type AccountDetailViewData } from "./panel.ts";
import { runTask, runCompletion } from "../agent/run.ts";
import { classifyTask, type TaskKind } from "../agent/classify.ts";
import { loadGearboxDocs, buildAskSystem, looksLikeGearboxQuestion, sessionDigest } from "../help/ask.ts";
import { resolveCreds } from "../accounts/resolve.ts";
import { markUsed, listAccounts, loadAccounts, setDefaultAccount, removeAccount, getAccount, putAccount, defaultAccount } from "../accounts/store.ts";
import type { Account } from "../accounts/types.ts";
import { importableEnvCreds, importEnvCred, importableCloudCreds, importCloudCred } from "../accounts/detect.ts";
import { addApiKeyAccount, addAzureAccount, addAzureFoundryAccount, addBedrockAccount, addByPastedKey, addOpenAICompatAccount, addVertexAccount, testAccount, addCliAccount, cliAuthStatus, cliLoginArgs, type AddResult } from "../accounts/onboard.ts";
import { ADD_SPECS, specFor, filterAddSpecs, buildPaletteAddRows, buildAddGuidance, type AddSpec } from "../accounts/add-spec.ts";
import { discoverModels } from "../accounts/discover.ts";
import { listDeploymentDetails, listAvailableModels, createDeployment, deleteDeployment, type AzureDeploymentInfo } from "../accounts/manage.ts";
import { catalogProvider, detectProviderByKey } from "../accounts/catalog.ts";
import { featuredApiKeyProviders, needsOnboarding, onboardingSummary, type OnboardingState } from "../accounts/onboarding.ts";
import { runCliTask, subscriptionEnv } from "../agent/cli-backend.ts";
import { recordRateLimits, recordBalance, buildUsageView, accountUsage, loadUsage, totalSpent, totalSpentToday, totalSpentThisMonth, type UsageView } from "../accounts/usage.ts";
import { recordSpend, resolveTurnCost, turnMetaOf, setSpendListener, readDailySpend, readAuxSpendToday } from "../accounts/ledger.ts";
import * as gitOps from "../git/ops.ts";
import { invalidateGitBranch } from "./git.ts";
import { gitConfirmOpen, gitConfirmEdit, gitConfirmSetSubmitting, gitConfirmError, gitConfirmReady, gitConfirmMessage, diffMove, diffScroll, diffSetText, type GitConfirmPanel } from "./panel.ts";
import { checkCaps, type BudgetCaps } from "../model/budget-guard.ts";
import { recordChange, planUndo, type FileChange } from "../undo.ts";
import { probeUsage } from "../accounts/usage-probe.ts";
import { fetchBalance, balanceExposed } from "../accounts/balance.ts";
import { buildContext, sanitizeToolPairs } from "../context/builder.ts";
import { repoMap } from "../context/repomap.ts";
import { compactHistory, modelSummarizer, estimateHistoryTokens, elideHistory, shouldAutoCompact } from "../context/compact.ts";
import { appendFact, loadFacts } from "../context/memory.ts";
import { fetchUrlText, urlsInText } from "../fetch.ts";
import { imageChipLabel, imageContent, imagePathsInText, isImageFilePath, loadImageAttachment, replaceImagePathWithMarker, type ImageAttachment } from "../image.ts";
import { missingRequirements, capabilitySummary, type ModelRequirement } from "../model/capabilities.ts";
import { writeProjectGuide } from "../init.ts";
import { detectVerificationCommands, runVerification, nextStepFor, shouldAutoFix, buildFixPrompt, provenTier, shouldOfferCharTest, buildCharTestPrompt, MAX_AUTOFIX_ATTEMPTS, type VerifyMode } from "../verify.ts";
import { runShellStream } from "../shell.ts";
import { helpText, formatModelList, compareModels, resolveModelSwitch, modelDirectiveIn, matchCommands, commandNameMatches, buildContextView, formatAccounts, accountLabel, accountName, accountSlug, ACCOUNT_ADD_HELP, badgeFor, closestCommand } from "../commands.ts";
import { checkHealth, recordHealth, isFresh, isNotDeployedError } from "../accounts/health.ts";
import { addMcpServer, formatMcpConfigList, mcpConfigPaths, mcpToolSummary, reloadMcpConnections, removeMcpServer, shellSplit } from "../mcp.ts";
import { applyKey, applyMouse, caretPos, extendUnitSelection, sanitizeInputText, selectionRange, wrapOffset, type Edit, type MouseClick } from "./input.ts";
import { copyToClipboard } from "./clipboard.ts";
import { clipboardImageToFile } from "./clipboard-image.ts";
import { setTitle, bell, notify } from "./terminal.ts";
import { navHistory, searchHistory } from "./history.ts";
import pkg from "../../package.json";
import { currentMention, matchFiles, completeMention } from "./mention.ts";
import { listProjectFiles, expandMentions } from "./files.ts";
import { useTerminalSize } from "./useTerminalSize.ts";
import { useOnline, isNetworkError } from "./net.ts";
import { gitBranch } from "./git.ts";
import { basename, extname, resolve } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { writeFile as fsWriteFile, unlink as fsUnlink } from "node:fs/promises";
import { computeDiff, diffStat } from "../diff.ts";
import { updateRetrievalFile, resetRetrievalIndex } from "../context/retrieve.ts";
import { addToast, TOAST_TTL_MS, type Toast, type ToastKind } from "./toast.ts";
import { editorNames, setEditorPref } from "./links.ts";
import { liveCheckAll, formatDoctorRows } from "../accounts/doctor.ts";
import { searchSessions } from "../session-search.ts";
import { syncModelsDev } from "../model/modelsdev.ts";
import { checkFileDiagnostics, formatDiagnostics, shutdownAllLsp } from "../lsp/diagnostics.ts";
import { loadPlugins, emitHook, installPluginLogger } from "../plugins.ts";
import { loadAgents, agentInvocation, type AgentDef } from "../agents.ts";
import { recordTurnOutcome } from "../model/priors.ts";
import { armDeviceLogin, armAuthReady } from "../accounts/azure-arm.ts";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { spawnSyncProc, which } from "../proc.ts";
import { handleCommand as dispatchCommand, KEYS_HELP, clipForPrompt, splitSubject, type CommandCtx } from "./command-handler.ts";

export type Runner = (opts: {
  prompt: string;
  messages: ModelMessage[];
  onEvent: OnEvent;
  selector: ModelSelector;
  signal: AbortSignal;
  escalate?: number; // prior failed-check count → router climbs to a stronger model
}) => Promise<{ messages: ModelMessage[]; usage: Usage }>;

// Turn a raw error into something actionable. Network failures are the common
// case worth special-casing: say "you appear to be offline" + a retry hint
// instead of a stack-ish ENOTFOUND string.
function friendlyError(msg: string): string {
  if (isNetworkError(msg)) return `can't reach the provider · you appear to be offline · check your connection, then /retry`;
  return msg;
}

function firstPath(text: string): string | null {
  const m = text.match(/(?:^|\s)([./~\w-][^\s:]*\.[\w-]+)(?:\s|$)/);
  return m?.[1] ?? null;
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

// Human-readable turn duration: sub-minute gets one decimal (4.2s); a minute or
// more is m s (1m 23s); sub-second rounds up to 0.1s so it never reads "0.0s".
export function formatDuration(ms: number): string {
  const s = ms / 1000;
  // Sub-minute: one decimal (4.2s) — unless it rounds up to 60.0s, then carry.
  const oneDecimal = Math.max(0.1, Math.round(s * 10) / 10);
  if (oneDecimal < 60) return `${oneDecimal.toFixed(1)}s`;
  // A minute or more: round to whole seconds FIRST, then split — so the seconds
  // can never round to 60 and read "1m 60s" (119.6s → 120 → "2m 0s").
  const total = Math.round(s);
  const m = Math.floor(total / 60);
  return `${m}m ${total % 60}s`;
}

export type CliModelChoice = { id: string; label: string; provider: string; efforts?: string[] };

// Claude CLI has no --thinking-effort flag · effort is not passed through.
const CLAUDE_CLI_EFFORTS: string[] = [];
const FALLBACK_CODEX_MODELS: CliModelChoice[] = [
  { id: "gpt-5.5", label: "gpt-5.5", provider: "codex", efforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.4", label: "gpt-5.4", provider: "codex", efforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.4-mini", label: "gpt-5.4-mini", provider: "codex", efforts: ["low", "medium", "high", "xhigh"] },
];
// A short, human category for a failover narration ("sonnet rate-limited → …").
// The (backend kind, account) identity of a routing pick — the unit the
// API↔seat switch notice compares across turns.
const backendKeyOf = (b: Backend | undefined): { kind: string; accountId?: string } => ({
  kind: b?.kind ?? "in-loop",
  accountId: b && "account" in b ? b.account?.id : undefined,
});

function shortFailure(message: string): string {
  const m = (message || "").toLowerCase();
  if (/\b402\b|credit|payment|billing|out of credit/.test(m)) return "out of credit";
  if (/over(loaded|capacity)|\b529\b/.test(m)) return "overloaded";
  if (/usage.?limit/.test(m)) return "at its usage limit";
  if (/quota|insufficient_quota/.test(m)) return "out of quota";
  if (/expired|session (?:has )?ended|not logged in|re-?authenticat/.test(m)) return "expired";
  if (/\b401\b|invalid|unauthorized|authentication/.test(m)) return "auth failed";
  return "rate-limited";
}

const TITLE_SYSTEM =
  "You title coding sessions. Reply with ONLY a 3-8 word title summarizing what the user is working on — lowercase except proper nouns and code identifiers, no quotes, no trailing period. Example: fix azure deploy 404 in manage.ts";

// The verify pillar's FAST tier: language-server diagnostics on the turn's
// changed files. Free when no server matches the project (detectServers is a
// which() + marker-file check); errors surface as a failed "lsp diagnostics"
// check so the auto-fix loop sees the exact compiler lines. Warnings never
// fail the tier (a turn must not go red over lint nits).
const LSP_FILE_RE = /\.(ts|tsx|js|jsx|py|go|rs)$/;
async function runLspTier(changed: string[], onEvent: OnEvent, onFileDiagnostics?: (file: string, diags: { line: number; col?: number; severity: "error" | "warning"; message: string }[]) => void): Promise<boolean> {
  const files = changed.filter((f) => LSP_FILE_RE.test(f)).slice(0, 8);
  if (!files.length) return false;
  let anyErrors = false;
  const startedAt = Date.now();
  let sawServer = false;
  const errorLines: string[] = [];
  for (const f of files) {
    try {
      const abs = resolve(process.cwd(), f);
      const content = readFileSync(abs, "utf8");
      const r = await checkFileDiagnostics(abs, content, process.cwd());
      if (r.note) continue; // no server for this file / failed to start — the shell tier covers it
      sawServer = true;
      const errs = r.diagnostics.filter((d) => d.severity === "error");
      // Surface per-file diagnostics to the transcript: they render under the
      // edit's diff (◆ line:col message), so the proof sits with the change.
      const surfaced = r.diagnostics
        .filter((d) => d.severity === "error" || d.severity === "warning")
        .map((d) => ({ line: d.line, col: d.col, severity: d.severity as "error" | "warning", message: d.message }));
      if (surfaced.length) onFileDiagnostics?.(f, surfaced);
      if (errs.length) {
        anyErrors = true;
        errorLines.push(formatDiagnostics(errs, 6, process.cwd()));
      }
    } catch { /* diagnostics are best-effort — verification still has the shell tier */ }
  }
  if (!sawServer) return false;
  onEvent({
    type: "verification",
    command: "lsp diagnostics",
    ok: !anyErrors,
    summary: anyErrors ? errorLines.join("\n").split("\n")[0]!.slice(0, 160) : "passed",
    intent: "typecheck",
    durationMs: Date.now() - startedAt,
    output: anyErrors ? errorLines.join("\n") : undefined,
  });
  return anyErrors;
}

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

// What the turn is doing RIGHT NOW, as two short strings for the Working
// block's side column (beside Boo): the current action (+ its ticking elapsed)
// and a short trail of recent steps/checks. Pure over the item list.
export function turnActivity(items: Item[], width: number): { action: string | null; trail: string | null } {
  const lastUser = items.map((it, i) => ({ it, i })).reverse().find((x) => x.it.kind === "user")?.i ?? -1;
  const turn = items.slice(lastUser + 1);
  const tools = turn.filter((i): i is Extract<Item, { kind: "tool" }> => i.kind === "tool");
  const phase = [...turn].reverse().find((i) => i.kind === "phase" && i.state === "running") as Extract<Item, { kind: "phase" }> | undefined;
  const running = [...tools].reverse().find((t) => t.status === "running");
  const cur = running ?? tools[tools.length - 1];
  const checks = turn.filter((i): i is Extract<Item, { kind: "verification" }> => i.kind === "verification").slice(-2);
  if (!cur && !phase && !checks.length) return { action: null, trail: null };

  const isShell = !!cur && (cur.name === "run_shell" || cur.name === "command_execution" || cur.name === "Bash");
  const target = cur?.arg ? (isShell ? cur.arg : relPath(cur.arg)).replace(/\n/g, " ").slice(0, Math.max(width - 26, 12)) : "";
  const head = cur ? `${friendlyTool(cur.name)}${target ? " " + target : ""}` : phase ? phase.label : "working";
  const timer = running?.startedAt ? fmtElapsed(Math.floor((Date.now() - running.startedAt) / 1000)) : "";
  const trail = tools.slice(-3).map((t) => `${t.status === "running" ? glyph.running : t.status === "err" ? glyph.cross : glyph.check} ${friendlyTool(t.name)}`).join("  ");
  const checkText = checks.map((c) => `${c.ok ? glyph.check : glyph.cross} ${c.command}`).join("  ");
  return {
    action: `${head}${timer ? "  · " + timer : ""}`,
    trail: [trail || null, checkText || null].filter(Boolean).join("   ") || null,
  };
}

function SetupSplash({ state, width, skin, splashSize }: { state: OnboardingState; width: number; skin: GhostLook; splashSize: "big" | "mini" | "none" }) {
  const detected = state.importable.length + state.cloudImportable.length;
  const panelWidth = Math.min(Math.max(width - 4, 30), 58);

  return (
    <Box flexDirection="column" alignItems="center">
      {/* ONE wordmark + ONE tagline (the splash used to print its own pair and
          this added a second — three "gearbox"es counting the Banner). */}
      <MascotSplash skin={skin} size={splashSize} tagline="one terminal · every model you already pay for" />

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
            <Text color={color.dim}>get started in seconds:</Text>
            <Box marginTop={1}>
              <Text color={color.accent}>/account</Text>
              <Text color={color.faint}>  guided setup · any provider</Text>
            </Box>
            <Box marginTop={1}>
              <Text color={color.faint}>or paste directly: </Text>
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

/** A conversation snapshot carried into a forked tab (saved as a session in
 *  the new tab's slug, then resumed there). */
export interface ForkPayload {
  title: string;
  messages: unknown[];
  items: unknown[];
  turns: unknown[];
}

/** Conductor-provided tab controls, surfaced as /tab + ctrl+t inside each session. */
export interface TabControl {
  create: (name?: string, opts?: { task?: string; fork?: ForkPayload }) => void;
  close: () => void;
  switchTo: (n: number) => void; // 1-based
  cycle: (delta: number) => void;
  list: () => { title: string; dir: string; active: boolean; status: string }[];
}

/** What a session reports up to the conductor's tab strip. */
export interface SessionStatus {
  busy: boolean;
  needsInput: boolean; // a permission prompt is waiting
  title: string;
}

export interface AppProps {
  selector: ModelSelector;
  runner?: Runner;
  fullscreen?: boolean;
  resumeId?: string; // resume this saved session on launch (--continue)
  /** Fixed workspace root for THIS instance (conductor tabs run one per worktree).
   *  Captured once; background turns stay rooted here even after the active tab
   *  chdir'd elsewhere. Default: process.cwd() at mount. */
  root?: string;
  /** Is this instance the focused tab? Gates keyboard/mouse input and
   *  terminal-title side effects. Default true (single-session mode). */
  active?: boolean;
  onStatus?: (s: SessionStatus) => void;
  tabs?: TabControl;
  /** conductor session tabs, rendered as the CLICKABLE masthead tab bar */
  tabRows?: TabRow[] | null;
  /** submit this prompt as the session's first turn on mount (/tab run) */
  initialPrompt?: string;
  /** This tab's Boo look (a wardrobe tab wears its namesake costume — tab
   *  "wizard" → the wizard persona). Overrides the ghost pref for this
   *  instance; /ghost still re-dresses it live. */
  ghostLook?: GhostLook;
}

export function App({ selector: initialSelector, runner, fullscreen = false, resumeId, root: rootProp, active = true, onStatus, tabs, tabRows, initialPrompt, ghostLook }: AppProps) {
  const { exit } = useApp();
  // The instance's workspace, FIXED at mount: per-turn root capture, the
  // session-save slug, and permission routing key off this — never off the
  // process-global cwd, which follows whichever tab is active.
  const rootRef = useRef(rootProp ?? process.cwd());
  const activeRef = useRef(active);
  activeRef.current = active;
  // Live mirrors for the raw mouse handler (registered once; reading props
  // through refs avoids re-subscribing the stdin listener per status change).
  const tabRowsRef = useRef(tabRows);
  tabRowsRef.current = tabRows;
  const tabsCtlRef = useRef(tabs);
  tabsCtlRef.current = tabs;
  // Set after their values exist each render; the mouse handler reads them.
  const handleCommandRef = useRef<((text: string) => void) | null>(null);
  const bannerAccountRef = useRef<string | null>(null);
  const { stdin, isRawModeSupported, setRawMode } = useStdin();
  const { columns, rows } = useTerminalSize();
  const online = useOnline(20_000, true); // background reachability → "⚠ offline"
  const onlineRef = useRef(online); // fresh mirror for run callbacks, avoids a stale closure
  onlineRef.current = online;
  // Chrome (title bar, rules, composer, status) spans the full terminal width;
  // long prose wraps at a readable cap inside it (see Transcript).
  const width = columns;
  const widthLiveRef = useRef(width);
  widthLiveRef.current = width;
  // 2× ghost is 40 cols × 20 rows; 1× mini is 20 × 10. Gate so neither overflows
  // a short/narrow terminal (wordmark-only when tiny).
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
  // A conductor tab named from the wardrobe dresses Boo in its namesake costume;
  // otherwise the persisted /ghost pref applies.
  const [ghostSkin, setGhostSkinState] = useState<GhostLook>(() => {
    if (ghostLook && isGhostLook(ghostLook)) return ghostLook;
    const g = loadPrefs().ghost;
    return g && isGhostLook(g) ? g : "base";
  });
  // One-shot splash moods (wink after a pin, hearts after a theme switch,
  // sleepy when idle on home). flashMood decays back to the base face; a real
  // state change (typing, a turn starting) always wins because the splash only
  // renders on the idle home/welcome screens.
  const [ghostMood, setGhostMood] = useState<{ face: string; overlay?: "tears" | "dots" | "load" | "zzz" | "sparkle" | "confetti" | "hearts" } | null>(null);
  const moodTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashMood = (face: string, overlay?: "hearts" | "sparkle" | "confetti", ms = 1600) => {
    setGhostMood({ face, overlay });
    if (moodTimerRef.current) clearTimeout(moodTimerRef.current);
    moodTimerRef.current = setTimeout(() => setGhostMood(null), ms);
  };
  // Counter bumped on /theme so the whole tree repaints in the new palette
  // (components read `color.*` lazily; this just forces the render pass).
  // Threaded into memoized components (Banner) so their memo invalidates too.
  const [themeEpochState, setThemeEpochState] = useState(0);
  // `linger` keeps the working line visible briefly after a turn for the celebrate/error beat.
  const [mascotState, setMascotState] = useState<MascotState>("thinking");
  const [linger, setLinger] = useState(false);
  const lingerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Pause the type-ahead drain after an error/interrupt so it doesn't auto-fire the queue into a broken state.
  const lastTurnFailedRef = useRef(false);
  // Type-ahead: prompts submitted while busy are queued and sent when the turn ends.
  const queueRef = useRef<string[]>([]);
  const [queued, setQueued] = useState<string[]>([]);
  const ctrlCRef = useRef(0); // timestamp of the last ⌃C, for "press again to quit"
  const escRef = useRef(0); // timestamp of the last esc, for double-esc rewind
  const notifyRef = useRef(loadPrefs().notify !== false); // desktop notify on long turns (pref-gated)
  const verifyRef = useRef<VerifyMode>(loadPrefs().verify === "off" ? "off" : "auto"); // post-edit checks + auto-iterate-to-green
  const charTestOfferedRef = useRef(false); // characterization-test offer: once per session
  const lastChangedFilesRef = useRef<string[]>([]); // most recent edited-turn file list (/verify test targets these)
  // /commit + /pr: regeneration inputs for the confirm panel's ⌃R, and the
  // inline-mode draft awaiting `/commit go` · `/pr go`.
  const gitRegenRef = useRef<{ mode: "commit" | "pr"; system: string; prompt: string; files: string[]; stat: string } | null>(null);
  const gitDraftRef = useRef<{ mode: "commit" | "pr"; subject: string; body: string } | null>(null);
  // The agent persona for the CURRENT turn (`@scout …`), read by defaultRunner.
  const agentTurnRef = useRef<AgentDef | null>(null);
  // Reports from BACKGROUNDED delegate sub-tasks, delivered into the next
  // turn's prompt (the model asked for them; the user saw the notice).
  const pendingBackgroundRef = useRef<string[]>([]);
  // The flywheel's recording hooks: what kind routed this turn (+ how it was
  // determined, for /why provenance), and the last edited turn's (kind, model)
  // so /undo can debit it as a human revert.
  const routedKindRef = useRef<{ kind: TaskKind; source: string } | null>(null);
  // The backend that served the last auto-routed turn, so a silent hop between
  // a metered API account and a subscription seat gets a one-line notice.
  const lastBackendRef = useRef<{ kind: string; accountId?: string } | null>(null);
  // WIRE TRUTH: the model id the provider's response says served the last
  // turn. The routing line cross-checks this against what we requested.
  const servedModelRef = useRef<string | null>(null);
  // Last turn's non-history context overhead (system/memory/repomap/retrieval),
  // so auto-compact triggers on the full context, not history alone. Starts at
  // a conservative estimate, not 0: a session RESUMED near the window would
  // otherwise run its whole first turn with overhead=0 and miss the auto-compact
  // that should have fired before it (overflow instead of a graceful compact).
  // The first in-loop turn replaces it with the measured value.
  const ctxOverheadRef = useRef(12_000);
  const lastOutcomeKeyRef = useRef<{ kind: string; modelId: string } | null>(null);
  const capsRef = useRef<BudgetCaps>(loadPrefs().budgetCaps ?? {}); // hard spend ceilings (/cap)
  const undoStackRef = useRef<{ changes: FileChange[]; at: number; checkpoint?: string }[]>([]); // per-turn file snapshots for /undo + /diff
  // Lazy whole-tree turn checkpoint (the /undo substrate for shell deletes and
  // renames): taken by the broker's pre-mutation hook at a turn's FIRST mutating
  // tool, attached to the turn's undo entry in the finally below.
  const turnSeqRef = useRef(0);
  const turnCheckpointRef = useRef<string | null>(null);
  // The session's diff baseline: the sha of the FIRST turn checkpoint. /diff
  // measures the whole session against it (pruning may drop the REF later, but
  // the commit object stays resolvable for weeks — long past any session).
  const sessionBaseRef = useRef<string | null>(null);
  const firstRunRef = useRef(!loadPrefs().onboarded); // show setup tips until a real account exists
  // Large pastes collapse to a `[Pasted N lines]` chip in the composer; the real
  // text is kept here and expanded back in on submit.
  const pasteStoreRef = useRef<Map<string, string>>(new Map());
  const pasteBufRef = useRef<string | null>(null); // accumulates a bracketed paste (\x1b[200~ … \x1b[201~) across reads
  const pasteIdRef = useRef(0);
  // Markerless-paste coalescer: terminals without bracketed paste (tmux/ssh/some
  // emulators) deliver a paste as several rapid reads. Accumulate within a short
  // quiet window so one paste becomes one chip + one render, not N chips and N re-renders.
  const pasteCoalesceRef = useRef<string | null>(null);
  const pasteCoalesceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedSelectionRef = useRef("");
  const mouseAnchorRef = useRef<number | null>(null);
  // Word/line-wise drag extension after a double/triple click on the composer:
  // the anchor unit (the word/line first selected) that the drag hulls against.
  const composerUnitDragRef = useRef<{ mode: "word" | "line"; start: number; end: number } | null>(null);
  // Home-screen composer mouse geometry (the composer floats mid-screen there).
  // Computed in render scope beside homeJsx — the one place that knows the
  // centered layout's heights — and read by the raw mouse handler.
  const homeGeomRef = useRef<{ firstInputRow: number; left: number; width: number } | null>(null);
  const transcriptMouseAnchorRef = useRef<{ line: number; col: number } | null>(null);
  const transcriptRangeAnchorRef = useRef<{ line: number; col: number } | null>(null);
  // In-progress transcript drag granularity: `char` tracks the raw point; `word`/`line`
  // extend by the hull of the anchor range and the word/line under the cursor (double/
  // triple-click), so dragging keeps whole-word/whole-line selection.
  const transcriptDragRef = useRef<{ mode: "char" | "word" | "line"; anchor: ViewSelection } | null>(null);
  const lastComposerClickRef = useRef<{ time: number; x: number; y: number; count: number } | null>(null);
  const lastTranscriptClickRef = useRef<{ time: number; x: number; y: number; count: number } | null>(null);
  const linesRef = useRef<Line[]>([]);
  const scrollTopLiveRef = useRef(0);
  const transcriptHeightLiveRef = useRef(1);
  const [transcriptSelection, setTranscriptSelectionState] = useState<ViewSelection | null>(null);
  const transcriptSelectionRef = useRef<ViewSelection | null>(null);
  // Ephemeral toasts (src/ui/toast.ts): short confirmations that expire after
  // ~2s instead of becoming permanent transcript lines.
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastIdRef = useRef(0);
  const toastTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const outCharsRef = useRef(0); // streamed output chars this turn, for a live tok/s estimate
  // Measured from the first output token, not turn start, so thinking time doesn't drag the rate to ~1/s.
  const firstOutputAtRef = useRef(0);
  const [, bumpMotion] = useReducer((x: number) => x + 1, 0);
  const [yolo, setYoloState] = useState(isYolo());
  const [perm, setPermState] = useState<PermRequest | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [expandAll, setExpandAll] = useState(false); // ⌃O: show full diffs/tool output
  const [search, setSearchState] = useState<{ q: string; idx: number } | null>(null); // ⌃R reverse-i-search
  const [paletteIndex, setPaletteIndexState] = useState(0);
const searchRef = useRef<{ q: string; idx: number } | null>(null);
  const paletteIndexRef = useRef(0);
  // Floating pickers (fullscreen only): clicking the model/effort label in the status bar
  // opens a picker above it. Slash commands remain the keyboard path.
  const [quickPicker, setQuickPickerState] = useState<null | "model" | "effort">(null);
  const [quickPickerIndex, setQuickPickerIndexState] = useState(0);
  const quickPickerRef = useRef<null | "model" | "effort">(null);
  const quickPickerIndexRef = useRef(0);
  const setQuickPicker = (p: null | "model" | "effort") => {
    quickPickerRef.current = p;
    setQuickPickerState(p);
    quickPickerIndexRef.current = 0;
    setQuickPickerIndexState(0);
  };
  const setQuickPickerIndex = (n: number) => {
    quickPickerIndexRef.current = n;
    setQuickPickerIndexState(n);
  };
  const setupRequiredRef = useRef(false); // mirrors setupRequired for the raw mouse handler
  // Dismissable command panel (fullscreen only): big info dumps and interactive
  // account/model lists render here instead of in the transcript. Esc closes.
  const [panel, setPanelState] = useState<PanelState | null>(null);
  const panelRef = useRef<PanelState | null>(null);
  type PanelUpdater = PanelState | null | ((p: PanelState | null) => PanelState | null);
  const setPanel = (up: PanelUpdater) => {
    const next = typeof up === "function" ? up(panelRef.current) : up;
    panelRef.current = next;
    setPanelState(next);
  };
  const panelMaxScrollRef = useRef(0); // max scroll for a static panel, set in render
  const panelAccountSlugsRef = useRef<string[]>([]); // row index → /account <slug>, set in render
  const panelSessionsRef = useRef<Session[]>([]); // row index → Session to load, set in render
  // Monotonic token for account-detail loads: every fire bumps it, every .then
  // checks it — a stale response (open vs refresh vs post-create racing) can
  // never overwrite a newer one.
  const detailLoadSeqRef = useRef(0);
  // Persistent usage strip (toggled by /usage) — stays above the composer until toggled
  // off, survives restarts, does not capture input.
  const [statusPinned, setStatusPinnedState] = useState(() => Boolean(loadPrefs().statusPinned));
  const [usageTick, bumpUsage] = useReducer((x: number) => x + 1, 0); // bump forces the strip to re-read usage.json; otherwise it's memoized off the hot path
  const [probing, setProbing] = useState<Set<string>>(new Set()); // account ids with a usage probe in flight, shown as "checking…"
  const setStatusPinned = (v: boolean) => {
    setStatusPinnedState(v);
    updatePrefs({ statusPinned: v });
  };
  // The live usage view (same data as /cost's card) — used by the pinned strip.
  const currentUsageView = (): UsageView => {
    const accounts = listAccounts();
    const resolve = (id: string) => {
      const a = getAccount(id);
      if (a) {
        const bin = a.auth.kind === "cli" ? a.auth.binary : undefined;
        return { name: accountName(a), kind: (a.exec === "cli" ? "sub" : "api") as "sub" | "api", provider: a.provider, balanceExposed: a.exec !== "cli" && balanceExposed(a.provider), limitNote: a.exec === "cli" ? `limits appear after the first ${bin === "codex" ? "Codex" : "Claude"} turn` : undefined };
      }
      if (id === "unknown") return { name: "(unattributed)", kind: "api" as const };
      // Env-key turns (no stored account) are ledgered as `env:<provider>` so a
      // `/budget <provider>` depletes correctly — show them under the provider name.
      if (id.startsWith("env:")) { const p = id.slice(4); return { name: p, kind: "api" as const, provider: p, balanceExposed: balanceExposed(p) }; }
      return { name: id, kind: "api" as const };
    };
    return buildUsageView(estimateCost(sessionRef.current.turns), resolve, Date.now(), accounts.map((a) => a.id));
  };
  // Usable (API) models for the /model panel — same grouping + rank order as
  // the inline `/model` list (commands.ts compareModels) so the two can't drift.
  const buildPanelModelRows = (cur?: string | null): PanelModelRow[] => {
    const usable = modelRegistry().filter((m) => providerAvailable(m.provider));
    const byProvider = new Map<string, typeof usable>();
    for (const m of usable) {
      if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
      byProvider.get(m.provider)!.push(m);
    }
    const out: PanelModelRow[] = [];
    for (const group of byProvider.values()) {
      group.sort(compareModels);
      for (const m of group) out.push({ id: m.id, label: m.label, provider: m.provider, current: m.id === cur });
    }
    return out;
  };
  // Open a scrollable static info panel (fullscreen only). Returns false inline so callers
  // fall back to printing in the transcript, keeping it uncluttered.
  const openInfoPanel = (title: string, item: Item): boolean => {
    if (!fullscreen) return false;
    atBottomRef.current = true;
    setPanel({ kind: "static", title, items: [item], scroll: 0 });
    return true;
  };
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
  const [vim, setVimState] = useState<"off" | "insert" | "normal">(loadPrefs().vim ? "insert" : "off");
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

  // Reflect status in the terminal window/tab title (OSC 2). Active tab only —
  // a background session finishing must not retitle the user's terminal.
  useEffect(() => {
    if (!active) return;
    const proj = basename(rootRef.current);
    setTitle(busy ? `✳ ${proj} · working` : `${proj} · gearbox`);
  }, [busy, active]);

  // Report up to the conductor's tab strip: busy spinner, the needs-input badge
  // (a permission prompt is waiting), and this session's display title. NO
  // basename(root) fallback here: same-dir tabs (launch dir not a repo → no
  // worktree) all share one dir, so the dir name labeled every tab identically
  // ("Desktop"). The conductor falls back to the tab's own name instead.
  useEffect(() => {
    onStatus?.({ busy, needsInput: perm != null, title: sessionRef.current.title });
  }, [busy, perm, onStatus]);

  // Sticky bash mode: `!` on an empty composer enters it (the ! is consumed), each
  // Enter runs the line as a shell command, esc exits back to normal input. (iii)
  const [bashMode, setBashMode] = useState(false);
  const bashModeRef = useRef(false);
  bashModeRef.current = bashMode;

  // Refs read by the (closure-captured) input handler · avoids stale state.
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
  const liveLineRef = useRef(""); // the in-progress draft, stashed when you step up into history so ↓ restores it
  const lastPromptRef = useRef<string | null>(null);
  const routedRef = useRef<{ model: ModelSpec; reason: string } | null>(null); // the real per-turn pick
  // The model label this turn FELL BACK FROM, when same-turn failover moved off the
  // intended account. Set in the failover loop, read once at the turn-completion seam
  // (drives the surprising-amber per-turn line), cleared in the turn's finally.
  const fellOverFromRef = useRef<string | null>(null);
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
  const cliMetaRef = useRef<{ costUSD?: number; rates?: { utilization?: number; status?: string; resetsAt?: number; type?: string }[] } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const interruptedRef = useRef(false);
  const ghostSkinRef = useRef<GhostLook>(
    ghostLook && isGhostLook(ghostLook) ? ghostLook
    : loadPrefs().ghost && isGhostLook(loadPrefs().ghost!) ? loadPrefs().ghost! : "base",
  );
  const permRef = useRef<PermRequest | null>(null);
  const permQueue = useRef<{ req: PermRequest; resolve: (d: PermDecision) => void }[]>([]);
  const scrollTopRef = useRef(0);
  const viewportHeightRef = useRef(1);
  const maxScrollRef = useRef(0);
  const paletteRowsLiveRef = useRef(0); // PALETTE_ROWS, for status-bar click hit-testing
  const homeScreenRef = useRef(false); // fullscreen home screen (composer mid-screen, not at the bottom)
  const statusBarRenderRef = useRef<{ model: string; costText: string; ctxPct: number | null; width: number; where: string; chipLen: number }>({ model: "", costText: "", ctxPct: null, width: 0, where: "", chipLen: 0 });
  // The shared page column's left offset (Broadsheet "one page"): footer surfaces
  // are indented by this, so the composer mouse hit-test must subtract it.
  const pageLeftRef = useRef(0);
  const pageWRef = useRef(80); // the page column width (meter/composer) for mouse hit math

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
    let acctId = loadPrefs().activeAccount;
    // First-run / subscription-only: onboarding adds the CLI account but doesn't
    // activate it. If nothing is active and there's no usable API model, activate
    // the first enabled subscription so the app works out of the box (otherwise the
    // model reads "none", turns fail, and /model shows an empty list).
    if (!acctId && buildPanelModelRows().length === 0) {
      acctId = listAccounts().find((a) => a.enabled && a.exec === "cli")?.id;
    }
    if (!acctId) return;
    const a = getAccount(acctId);
    if (a && a.exec === "cli") {
      const bin = (a.auth as any).binary as string;
      activeCliRef.current = { id: a.id, binary: bin, profile: (a.auth as any).loginProfile };
      if (activeCliModelRef.current && !cliSupportsModel(bin, activeCliModelRef.current)) setActiveCliModelId(undefined);
      setActiveCli({ id: a.id, label: accountName(a) }); // accountName (not the bare binary) so the status bar + usage-strip match
      updatePrefs({ activeAccount: a.id }); // persist the auto-activation
    }
  }, []);

  // One-time, best-effort model discovery for in-loop accounts that have never
  // been discovered (added before discovery existed, or imported from env). Keeps
  // the model list honest without making the user run /account refresh. Persists
  // the real set; marks "discovered, none" as [] so it doesn't re-run every launch;
  // leaves a failed discovery undefined to retry next time.
  const discoveryRanRef = useRef(false);
  useEffect(() => {
    if (discoveryRanRef.current) return;
    discoveryRanRef.current = true;
    void (async () => {
      const targets = listAccounts().filter((a) => a.enabled && a.exec !== "cli" && a.models === undefined);
      let learned = 0;
      for (const a of targets) {
        try {
          const d = await discoverModels(a);
          if (d.ok) {
            putAccount({ ...a, models: d.models });
            if (d.models.length) learned++;
          }
        } catch {
          /* best-effort; retry next launch */
        }
      }
      if (learned) notice(`loaded the real model list for ${learned} account${learned === 1 ? "" : "s"} · /model to see them`);
    })();
  }, []);

  // Boot: probe accounts whose health is stale so the first /account is accurate.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const now = Date.now();
      const stale = listAccounts().filter((a) => !isFresh(a.health, now));
      await Promise.all(stale.map(async (a) => {
        try {
          const h = await checkHealth(a);
          if (cancelled) return;
          recordHealth(a, h.state, h.detail);
        } catch { /* best-effort; never block boot */ }
      }));
    })();
    return () => { cancelled = true; };
  }, []); // once on mount

  // Keep metered-credit balances fresh for the router's scarcity term. Only a
  // few providers expose a balance (DeepSeek / OpenRouter / Vercel); for those,
  // refresh on launch and every 5 min so a near-empty key is deprioritized
  // BEFORE it dead-ends. Best-effort: fetchBalance is timeout-guarded and never
  // throws, and routing treats a missing/stale balance as neutral (no penalty).
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      const targets = listAccounts().filter((a) => a.enabled && a.exec !== "cli" && balanceExposed(a.provider));
      for (const a of targets) {
        if (!alive) return;
        const bal = await fetchBalance(a);
        if (bal?.remainingUSD != null) recordBalance(a.id, bal);
      }
    };
    void refresh();
    const t = setInterval(() => void refresh(), 5 * 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // Mutating tools (write/edit/shell) block on this; the UI resolves it.
  useEffect(() => {
    const root = rootRef.current;
    const handler = (req: PermRequest) =>
      new Promise<PermDecision>((resolve) => {
        // Auto-accept-edits mode: apply file writes/edits without asking (the
        // diff still renders); shell commands are still gated.
        if (modeRef.current === "auto-accept" && (req.kind === "write" || req.kind === "edit")) {
          resolve("once");
          return;
        }
        permQueue.current.push({ req, resolve });
        pumpPerm();
      });
    // Registered under THIS instance's root: with multiple tabs mounted, a
    // background session's prompt lands on its own tab (the strip shows
    // "needs input"), not whichever tab registered last.
    registerPermissionHandler(root, handler);
    // Before a turn's FIRST mutating tool (under any approval path — yolo,
    // rules, and grants included), snapshot the whole tree. Synchronous, so the
    // tool can't mutate before the checkpoint exists. Checkpoints THIS root —
    // never the process-global cwd, which follows the active tab.
    const preMutation = () => {
      if (!busyRef.current || turnCheckpointRef.current) return;
      const seq = ++turnSeqRef.current;
      const r = gitOps.turnCheckpointSave(seq, root);
      if (!r.ok) return; // not a git repo / checkpoint failed → per-file snapshots still apply
      const name = gitOps.turnCheckpointName(seq);
      turnCheckpointRef.current = name;
      if (!sessionBaseRef.current) {
        const sha = gitOps.git(["rev-parse", `refs/gearbox/checkpoints/${name}`], root);
        if (sha.ok && sha.out) sessionBaseRef.current = sha.out;
      }
    };
    registerPreMutationHook(root, preMutation);
    return () => { registerPermissionHandler(root, null); registerPreMutationHook(root, null); };
  }, []);

  // The ACTIVE tab also owns the global fallback slots, so rootless requests
  // (MCP risky tools, headless paths) prompt on whatever the user is looking at.
  useEffect(() => {
    if (!active) return;
    setPermissionHandler((req) =>
      new Promise<PermDecision>((resolve) => {
        if (modeRef.current === "auto-accept" && (req.kind === "write" || req.kind === "edit")) { resolve("once"); return; }
        permQueue.current.push({ req, resolve });
        pumpPerm();
      }),
    );
    return () => setPermissionHandler(null);
  }, [active]);

  // Plugins (.gearbox/plugins/*.ts + ~/.gearbox/plugins/*.ts): loaded once at
  // boot. A broken plugin becomes a notice, never a crash; ctx.log and hook
  // errors surface as faint notices.
  useEffect(() => {
    installPluginLogger((msg) => notice(msg));
    void loadPlugins().then((r) => {
      if (r.errors.length) notice(`plugin errors:\n${r.errors.map((e) => `  ${e.file}: ${e.message}`).join("\n")}`);
      if (r.loaded.length) toast(`${r.loaded.length} plugin${r.loaded.length === 1 ? "" : "s"} loaded`, "info");
      void emitHook("session.start", { sessionId: sessionRef.current.id });
    });
    return () => { installPluginLogger(null as any); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // models.dev catalog: refresh in the background (24h cache) so newly shipped
  // models become pin-able without a release. Never blocks anything.
  useEffect(() => {
    void syncModelsDev({}).then((entries) => {
      if (entries.length) refreshModelsDevOverlay();
    }).catch(() => {});
  }, []);

  // Delegate sub-task spend flows into the session record (it previously hit
  // only the cross-session usage.json, so the status-bar $, /cap session, and
  // the cost tab under-counted fan-out turns). Main turns push their own
  // TurnMeta at settle, so only "delegate" events are mirrored here.
  useEffect(() => {
    setSpendListener((ev) => {
      if (ev.source === "delegate") sessionRef.current.turns.push(turnMetaOf(ev));
      bumpUsage(); // spend changed → the memoized strip re-reads usage.json
    });
    return () => setSpendListener(null);
  }, []);

  // Smooth scrolling: a wheel notch (or a fast swipe's burst of events) sets a
  // TARGET, and an easing loop glides scrollTop toward it a fraction of the
  // remaining distance each frame · so big jumps decelerate instead of snapping,
  // while a single line still moves immediately. The terminal grid is still
  // line-quantized; this just makes the motion between rows continuous.
  const scrollTargetRef = useRef<number | null>(null);
  const scrollAnimRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const noMotion = process.env.GEARBOX_NO_MOTION === "1";
  const stopScrollAnim = useCallback(() => {
    if (scrollAnimRef.current) { clearInterval(scrollAnimRef.current); scrollAnimRef.current = null; }
  }, []);
  // DIRECT scroll: one setScrollTop per wheel/key event, no easing glide. The
  // glide fired a 16ms setInterval that re-rendered the whole transcript several
  // times per scroll — on a tall buffer that's the "scroll is laggy". Terminals
  // are line-quantized, so a direct jump is both crisper and far cheaper.
  const scrollBy = useCallback((delta: number) => {
    stopScrollAnim();
    const max = maxScrollRef.current;
    const cur = atBottomRef.current ? max : scrollTopRef.current;
    const target = Math.max(0, Math.min(max, cur + delta));
    atBottomRef.current = target >= max;
    setScrollTop(target);
  }, [stopScrollAnim]);
  // Frame-throttle wheel scrolling. A trackpad / momentum scroll fires FAR more than
  // 60 events/sec, and each one re-renders + re-diffs the whole fullscreen frame —
  // the residual "mouse scroll feels laggy". Accumulate the delta and apply it at
  // most once per ~16ms: leading edge so the first notch is instant, trailing edge
  // so the rest stays smooth. Caps scroll renders at ~60fps regardless of event rate.
  const scrollAccumRef = useRef(0);
  const scrollFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushScroll = useCallback(() => {
    scrollFlushRef.current = null;
    const d = scrollAccumRef.current;
    scrollAccumRef.current = 0;
    if (d) scrollBy(d);
  }, [scrollBy]);
  const queueScroll = useCallback((delta: number) => {
    scrollAccumRef.current += delta;
    if (scrollFlushRef.current) return; // a trailing flush is scheduled; it picks up the accumulated delta
    flushScroll(); // leading edge: instant first response
    scrollFlushRef.current = setTimeout(flushScroll, 16);
  }, [flushScroll]);
  useEffect(() => stopScrollAnim, [stopScrollAnim]); // clear any glide timer on unmount
  useEffect(() => () => { if (scrollFlushRef.current) clearTimeout(scrollFlushRef.current); }, []); // clear the scroll-throttle timer on unmount
  useEffect(() => () => { const r = selRenderRef.current; if (r.t) clearTimeout(r.t); }, []); // clear the drag-flush timer on unmount
  useEffect(() => () => { if (pasteCoalesceTimerRef.current) clearTimeout(pasteCoalesceTimerRef.current); }, []); // clear the paste coalescer timer on unmount

  const toast = useCallback((text: string, kind: ToastKind = "ok") => {
    const id = ++toastIdRef.current;
    setToasts((prev) => addToast(prev, { id, text, kind, at: Date.now() }));
    const t = setTimeout(() => {
      toastTimersRef.current.delete(t);
      setToasts((prev) => prev.filter((x) => x.id !== id));
    }, TOAST_TTL_MS);
    toastTimersRef.current.add(t);
  }, []);
  useEffect(() => () => { for (const t of toastTimersRef.current) clearTimeout(t); }, []);
  useEffect(() => () => { void shutdownAllLsp(); }, []); // language servers die with the app
  const copyWithFeedback = useCallback((text: string) => {
    const clean = text.replace(/[ \t]+\n/g, "\n").trim();
    if (!clean) return;
    copyToClipboard(clean);
    toast(`copied ${clean.length} chars`);
  }, [toast]);
  const flashStatus = useCallback((text: string) => toast(text, "info"), [toast]);

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
  // FULLSCREEN-ONLY: inline mode doesn't grab the mouse (cli.tsx leaves reporting
  // off), so the terminal handles selection/scrollback natively — don't attach here.
  useEffect(() => {
    if (!stdin || !fullscreen || process.env.GEARBOX_MOUSE === "0") return;
    // The composer's mouse geometry — the ONE place that knows which terminal
    // rows hold input text. Bottom-up (Composer.tsx row contract, lift=true,
    // PTY-verified): meter(rows) · meter marginTop(rows-1) · composer
    // marginBottom(rows-2) · footer hint(rows-3) · pad(rows-4) · input rows
    // (rows-5 … rows-4-lineCount) · pad · marginTop. Keep in lockstep with
    // Composer.tsx and the footer estimate.
    const composerPoint = (x: number, y: number): { off: number } | null => {
      if (permRef.current) return null; // the consent line replaces the composer
      const value = editRef.current.value;
      // Home screen: the composer floats mid-screen — its geometry is computed
      // in render scope (where the layout values live) and published via ref.
      const home = homeScreenRef.current ? homeGeomRef.current : null;
      if (home == null && homeScreenRef.current) return null;
      const w = home ? home.width : pageWRef.current;
      const rowCount = composerRows(value, w); // display rows (soft wrap — same map the renderer uses)
      const firstInputRow = home ? home.firstInputRow : rows - 4 - rowCount;
      const lastInputRow = firstInputRow + rowCount - 1;
      const left = home ? home.left : pageLeftRef.current;
      if (y < firstInputRow || y > lastInputRow) return null;
      const row = y - firstInputRow;
      // 1 border + space + prompt + space, SGR coords are 1-based — plus the
      // column's left offset (page column in-session, centered box on home).
      const col = Math.max(0, x - 5 - left);
      return { off: wrapOffset(value, composerWrapW(w), row, col) };
    };
    // Which status-bar label, if any, sits under this click. Row + column math
    // lives in the pure, tested statusBarHit; here we only supply live layout.
    const statusBarZoneAt = (x: number, y: number): "model" | "context" | "cost" | "where" | null => {
      const { model, costText, ctxPct, width: w, where, chipLen } = statusBarRenderRef.current;
      if (homeScreenRef.current) {
        // Home screen: the composer lives mid-screen, so the status bar is the
        // very last row (marginTop + bar, nothing below it).
        if (y !== rows || !model) return null;
        const { modelZone } = statusBarLayout({ model, costText, ctxPct, width: pageWRef.current });
        const col = x - 1 - pageLeftRef.current; // the meter lives in the page column now
        return col >= modelZone[0] && col < modelZone[1] ? "model" : null;
      }
      const value = editRef.current.value;
      return statusBarHit({ x: x - pageLeftRef.current, y, termRows: rows, composerLines: composerRows(value, pageWRef.current), paletteRows: paletteRowsLiveRef.current, model, costText, ctxPct, width: pageWRef.current, where, chipLen });
    };
    const viewportTop = 4; // masthead (marginTop + masthead row + rule = 3 rows); viewport begins on row 4.
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
        // 3 lines per wheel notch (was 1 — felt sluggish). Single notches settle
        // instantly (the glide only kicks in for accumulated fast swipes), so
        // scrolling reads crisp rather than crawling.
        if (b === 64) delta -= 3;
        else if (b === 65) delta += 3;
        else {
          const isDrag = (b & 32) === 32;
          const isPrimary = (b & 3) === 0;
          // Masthead tab-bar clicks: switch sessions / + creates one. Allowed
          // while busy — switching away from a running turn is the point of
          // parallel sessions. Hit-test = the SAME pure layout the Masthead
          // rendered from, so click targets match the pixels exactly.
          if (fullscreen && isPrimary && !isDrag && !up && y === MASTHEAD_ROW && tabsCtlRef.current && tabRowsRef.current?.length) {
            const segs = tabBarSegments(tabRowsRef.current, TABBAR_LEFT, widthLiveRef.current - 1);
            const act = tabBarHit(segs, x - 1);
            if (act) {
              if (act.type === "new") tabsCtlRef.current.create();
              else if (act.type === "close") tabsCtlRef.current.close();
              else tabsCtlRef.current.switchTo(act.n);
              continue;
            }
            // The account name on the masthead's right edge opens /account.
            const az = mastheadAccountZone(bannerAccountRef.current, tabRowsRef.current, widthLiveRef.current);
            if (az && x - 1 >= az[0] && x - 1 < az[1]) {
              handleCommandRef.current?.("/account");
              continue;
            }
          }
          // Status-bar click pickers (fullscreen only). A primary press on the
          // model or effort label toggles its floating picker; a press anywhere
          // else closes an open one before normal click handling resumes.
          if (fullscreen && isPrimary && !isDrag && !up && !busyRef.current && !permRef.current) {
            const zone = statusBarZoneAt(x, y);
            if (zone === "model") {
              setQuickPicker(quickPickerRef.current === zone ? null : zone);
              continue;
            }
            if (zone) {
              // The meter's facts are doors: gauge → /context, $ → /usage,
              // cwd:branch → /diff (what changed here this session).
              handleCommandRef.current?.(zone === "context" ? "/context" : zone === "cost" ? "/usage" : "/diff");
              continue;
            }
            if (quickPickerRef.current) setQuickPicker(null);
          }
          const cp = composerPoint(x, y);
          const off = cp?.off ?? null;
          const point = transcriptPoint(x, y);
          if (isPrimary && isDrag && transcriptMouseAnchorRef.current && !point) {
            const bottom = viewportTop + transcriptHeightLiveRef.current - 1;
            if (y < viewportTop) scrollBy(-2);
            else if (y > bottom) scrollBy(2);
            const edgeLine = y < viewportTop ? scrollTopLiveRef.current : scrollTopLiveRef.current + transcriptHeightLiveRef.current - 1;
            const edgeText = lineText(linesRef.current[edgeLine] ?? []);
            setTranscriptSelLive({
              startLine: transcriptMouseAnchorRef.current.line,
              startCol: transcriptMouseAnchorRef.current.col,
              endLine: edgeLine,
              endCol: y < viewportTop ? 0 : edgeText.length,
            });
            continue;
          }
          if (up) {
            const drag = transcriptDragRef.current;
            transcriptDragRef.current = null;
            if (drag && (drag.mode === "word" || drag.mode === "line")) {
              // Word/line drag: the live ref already holds the hull selection; just
              // commit it (discrete) + copy on release.
              transcriptMouseAnchorRef.current = null;
              const sel = transcriptSelectionRef.current;
              if (sel) { setTranscriptSel(sel); copyTranscriptSelection(sel); }
            } else if (transcriptMouseAnchorRef.current) {
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
            composerUnitDragRef.current = null;
          } else if (cp != null && isPrimary && !isDrag) {
            // Composer click: track timing for double/triple-click detection.
            // The OFFSET comes from composerPoint (the one composer geometry,
            // soft-wrap aware); the LOGICAL line/col for applyMouse derive from
            // it — so the click, the drag anchor, and applyMouse always agree.
            const value = editRef.current.value;
            const { lineIdx, col } = caretPos(value, cp.off);
            const shift = (b & 4) !== 0;
            const now = Date.now();
            const prev = lastComposerClickRef.current;
            let clickCount = 1;
            if (prev && now - prev.time < 500 && prev.x === x && prev.y === y) {
              clickCount = Math.min(prev.count, 3) + 1;
            }
            lastComposerClickRef.current = { time: now, x, y, count: clickCount };
            const click: MouseClick = { line: lineIdx, col, count: clickCount, shift };
            mouseAnchorRef.current = cp.off;
            transcriptMouseAnchorRef.current = null;
            transcriptDragRef.current = null;
            setTranscriptSel(null);
            const action = applyMouse({ value, cursor: editRef.current.cursor, selectionAnchor: editRef.current.selectionAnchor }, click);
            if (action.type === "edit") setEdit(action.state);
            else setEdit({ value, cursor: cp.off });
            // Double/triple click selected a word/line — remember that unit so a
            // drag extends the selection word-/line-wise (hulling whole units).
            composerUnitDragRef.current =
              !shift && clickCount >= 2 && action.type === "edit" && action.state.selectionAnchor != null
                ? { mode: clickCount >= 3 ? "line" : "word", start: Math.min(action.state.selectionAnchor, action.state.cursor), end: Math.max(action.state.selectionAnchor, action.state.cursor) }
                : null;
          } else if (off != null && isDrag && mouseAnchorRef.current != null) {
            // Drag inside the composer. After a double/triple click the drag
            // extends word-/line-wise (the hull of the anchor unit and the unit
            // under the pointer — micro-motion on a trackpad just re-selects the
            // same word, so it can't clobber the click selection). A plain drag
            // extends character-wise from the press anchor.
            const unit = composerUnitDragRef.current;
            if (unit) {
              setEdit(extendUnitSelection(editRef.current.value, unit, off, unit.mode));
            } else if ((lastComposerClickRef.current?.count ?? 1) === 1) {
              setEdit({ value: editRef.current.value, cursor: off, selectionAnchor: mouseAnchorRef.current });
            }
          } else if (point && isPrimary && !isDrag) {
            const shift = (b & 4) !== 0;
            const clickCount = transcriptClickCount(x, y);
            // In-stream affordances: a span carrying a gearbox: link is a button,
            // not text — a plain click on `⑂ fork` forks this conversation into a
            // new tab instead of starting a selection.
            if (!shift && clickCount === 1) {
              const lk = linkAt(linesRef.current[point.line] ?? [], point.col);
              if (lk === "gearbox:fork" && tabsCtlRef.current) {
                handleCommandRef.current?.("/tab fork");
                continue;
              }
            }
            mouseAnchorRef.current = null;
            setEdit({ ...editRef.current, selectionAnchor: undefined });
            if (shift) {
              const existing = transcriptSelectionRef.current ? normalizedTranscriptSelection(transcriptSelectionRef.current) : null;
              const anchor = transcriptRangeAnchorRef.current ?? (existing ? { line: existing.startLine, col: existing.startCol } : point);
              transcriptMouseAnchorRef.current = null;
              transcriptDragRef.current = null;
              transcriptRangeAnchorRef.current = anchor;
              const sel = { startLine: anchor.line, startCol: anchor.col, endLine: point.line, endCol: point.col };
              setTranscriptSel(sel);
              copyTranscriptSelection(sel);
            } else if (clickCount >= 3) {
              const sel = transcriptLineRange(point);
              const norm = normalizedTranscriptSelection(sel);
              transcriptMouseAnchorRef.current = null;
              transcriptRangeAnchorRef.current = { line: norm.startLine, col: norm.startCol };
              transcriptDragRef.current = { mode: "line", anchor: sel }; // drag extends line-wise
              setTranscriptSel(sel);
              copyTranscriptSelection(sel);
            } else if (clickCount === 2) {
              const sel = transcriptWordRange(point);
              const norm = normalizedTranscriptSelection(sel);
              transcriptMouseAnchorRef.current = null;
              transcriptRangeAnchorRef.current = { line: norm.startLine, col: norm.startCol };
              transcriptDragRef.current = { mode: "word", anchor: sel }; // drag extends word-wise
              setTranscriptSel(sel);
              copyTranscriptSelection(sel);
            } else {
              transcriptMouseAnchorRef.current = point;
              transcriptRangeAnchorRef.current = point;
              transcriptDragRef.current = { mode: "char", anchor: { startLine: point.line, startCol: point.col, endLine: point.line, endCol: point.col } };
              setTranscriptSel({ startLine: point.line, startCol: point.col, endLine: point.line, endCol: point.col });
            }
          } else if (point && isDrag && transcriptDragRef.current) {
            // Extend the in-progress selection at its granularity. word/line take the
            // hull of the anchor range and the word/line under the cursor, so whole
            // words/lines stay selected on both sides; char tracks the raw point.
            const d = transcriptDragRef.current;
            if (d.mode === "char") {
              setTranscriptSelLive({ startLine: d.anchor.startLine, startCol: d.anchor.startCol, endLine: point.line, endCol: point.col });
            } else {
              const head = d.mode === "line" ? transcriptLineRange(point) : transcriptWordRange(point);
              setTranscriptSelLive(hullSelection(d.anchor, head));
            }
          } else if (point && isDrag && transcriptMouseAnchorRef.current) {
            setTranscriptSelLive({ startLine: transcriptMouseAnchorRef.current.line, startCol: transcriptMouseAnchorRef.current.col, endLine: point.line, endCol: point.col });
          }
        }
      }
      if (delta) {
        // While a command panel is open, the wheel scrolls IT (the transcript is
        // hidden underneath), matching the keyboard ↑↓ behaviour.
        const p = panelRef.current;
        if (p) {
          if (p.kind === "static") setPanel({ ...p, scroll: clampScroll(p.scroll + delta, panelMaxScrollRef.current) });
          else if (p.kind === "accounts") setPanel({ ...p, index: clampIndex(p.index + delta, panelAccountSlugsRef.current.length) });
          else if (p.kind === "sessions") setPanel({ ...p, index: clampIndex(p.index + delta, panelSessionsRef.current.length) });
          else if (p.kind === "wizard" && p.wizardPhase.phase === "pick") setPanel({ ...p, wizardPhase: { ...p.wizardPhase, index: clampIndex(p.wizardPhase.index + delta, filterAddSpecs(p.wizardPhase.filter).length) } });
          else if (p.kind === "models") setPanel({ ...p, index: clampIndex(p.index + delta, filterModelRows(buildPanelModelRows(), p.filter).length) });
          else if (p.kind === "account-detail" && p.detailPhase.phase === "browse") setPanel(detailMoveIndex(p, delta, p.deployments?.length ?? 0));
          else if (p.kind === "account-detail" && p.detailPhase.phase === "deploy-pick") {
            const q = p.detailPhase.filter.trim().toLowerCase();
            const filt = q ? (p.availableModels ?? []).filter((m) => m.toLowerCase().includes(q)) : (p.availableModels ?? []);
            setPanel(detailDeployMove(p, delta, filt.length));
          }
        } else queueScroll(delta); // frame-throttled (≤~60fps) so fast scrolls don't flood renders
      }
    };
    if (!active) return; // background tabs must not fight over the one mouse stream
    stdin.on("data", onData);
    return () => {
      stdin.off?.("data", onData);
    };
  }, [stdin, fullscreen, rows, scrollBy, queueScroll, copyWithFeedback, active]);

  // Save the current conversation (best-effort) · model-agnostic messages + the UI
  // transcript + per-turn model/usage, so it resumes faithfully and feeds routing.
  const persist = useCallback(() => {
    const s = sessionRef.current;
    if (!itemsRef.current.length) return;
    saveSession({
      id: s.id,
      cwd: rootRef.current,
      createdAt: s.createdAt,
      updatedAt: Date.now(),
      title: s.title,
      messages: msgRef.current,
      items: itemsRef.current,
      turns: s.turns,
    }, rootRef.current);
  }, []);

  // Saved sessions for this project, newest first, EXCLUDING the one you're in
  // (resuming the current session is a no-op / loads the just-cleared one). Drives
  // both the interactive /resume panel and the `/resume <n>` direct path.
  const resumableSessions = (): Session[] =>
    listSessions()
      .filter((s) => s.id !== sessionRef.current.id)
      .sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false) || b.updatedAt - a.updatedAt);
  const sessionWhen = (t: number): string => {
    const m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
  };
  const loadInto = (s: Session) => {
    idRef.current = s.items.reduce((m, i) => Math.max(m, i.id), 0) + 1;
    setItems(s.items);
    msgRef.current = s.messages;
    sessionRef.current = { id: s.id, createdAt: s.createdAt, title: s.title, turns: s.turns ?? [] };
    // Resumed history is plain text, not a vendor session id (we don't persist
    // one). Clear any stale CLI session so a subscription turn starts the binary
    // fresh with this history rather than --resume-ing whatever was last open.
    cliSessionRef.current = undefined;
    notice(`resumed · ${s.items.length} messages · ${new Date(s.updatedAt).toLocaleString()}`);
  };

  // On launch: load persisted prompt history; resume a session if asked
  // (--continue, or a forked tab whose snapshot was saved under this root).
  useEffect(() => {
    const h = loadHistory();
    if (h.length) historyRef.current = h;
    if (resumeId) {
      const s = loadSession(resumeId, rootRef.current);
      if (s) loadInto(s);
    }
    // Spawn-with-a-task (/tab run): submit the tab's initial prompt once the
    // turn machinery exists. Deferred a tick so the resumed history (fork) and
    // the first render land first.
    if (initialPrompt?.trim()) {
      const t = setTimeout(() => runTurnRef.current?.(initialPrompt), 50);
      return () => clearTimeout(t);
    }
  }, []);

  const setGhostSkin = (s: GhostLook) => {
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
  // A drag fires mouse events faster than the terminal can repaint. Update the
  // ref immediately (copy/edge logic always reads the true selection) but throttle
  // the actual re-render to ~60fps (leading + trailing), so a fast drag glides
  // instead of flooding the render loop. Used only for continuous drag-extend.
  const selRenderRef = useRef<{ t: ReturnType<typeof setTimeout> | null; pending: ViewSelection | null }>({ t: null, pending: null });
  const cancelSelFlush = () => {
    const r = selRenderRef.current;
    if (r.t) { clearTimeout(r.t); r.t = null; }
    r.pending = null;
  };
  const setTranscriptSel = (sel: ViewSelection | null) => {
    cancelSelFlush(); // a discrete update wins over any pending throttled drag frame
    transcriptSelectionRef.current = sel;
    setTranscriptSelectionState(sel);
  };
  const setTranscriptSelLive = (sel: ViewSelection) => {
    transcriptSelectionRef.current = sel;
    const r = selRenderRef.current;
    if (r.t) { r.pending = sel; return; } // a flush is already scheduled; keep the latest
    setTranscriptSelectionState(sel); // leading edge: show this frame now
    r.t = setTimeout(() => {
      r.t = null;
      if (r.pending) { setTranscriptSelectionState(r.pending); r.pending = null; }
    }, 16);
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
  // A single existing file path (from drag-drop OR a terminal that pastes an image
  // as its temp path) → attach: image becomes a chip, any other file an @mention.
  // Returns true when it handled the text. Mutates the composer via setEdit.
  const attachPastedPath = (text: string, e: Edit): boolean => {
    const p = sanitizeInputText(text).trim().replace(/^'|'$/g, "").replace(/\\ /g, " ");
    if (!p || p.includes("\n") || p.length >= 1024 || !/[/\\.]/.test(p)) return false;
    const abs = p.startsWith("~") ? p.replace(/^~/, process.env.HOME ?? "~") : resolve(process.cwd(), p);
    if (!existsSync(abs)) return false;
    // Reject a directory. A pasted path that arrives in chunks (macOS screenshot
    // paths do) can momentarily resolve to a real DIR prefix (e.g. `…/TemporaryItems/`
    // before the `NSIRD…/Screenshot….png` tail lands); accepting it here on the
    // per-read drag-drop path would `@dir`-mention that prefix and orphan the rest.
    // Bailing lets the chunk fall through to the paste coalescer, which reassembles
    // the whole path and attaches the real file. (A bare dir paste isn't a useful
    // mention anyway.)
    try { if (statSync(abs).isDirectory()) return false; } catch { return false; }
    if (isImageFilePath(abs)) {
      const marker = imageMarkerFor(abs);
      setEdit({ value: e.value.slice(0, e.cursor) + marker + " " + e.value.slice(e.cursor), cursor: e.cursor + marker.length + 1 });
      flashStatus(`attached ${basename(abs)}`);
    } else {
      const ins = `@${p} `;
      setEdit({ value: e.value.slice(0, e.cursor) + ins + e.value.slice(e.cursor), cursor: e.cursor + ins.length });
    }
    return true;
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
    rows.push("", "API models are hidden while a subscription is active · /account off returns to API routing\n  tip: /model haiku (or any API model name) switches directly and leaves the subscription");
    return rows.join("\n");
  };
  const resolveCliModel = (binary: string, query: string): { ok: true; modelId: string; label: string } | { ok: false; message: string } => {
    const q = query.trim().toLowerCase();
    const matches = cliModelChoices(binary).filter((m) => m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
    if (!matches.length) return { ok: false, message: `no ${binary} subscription model matching "${query}"` };
    const exact = matches.find((m) => m.label.toLowerCase() === q || m.id.toLowerCase() === q);
    const m = exact ?? (matches.length === 1 ? matches[0] : undefined);
    if (!m) return { ok: false, message: `"${query}" matches ${matches.map((x) => x.label).join(", ")} · be more specific` };
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
        ...buildPaletteAddRows().map((r) => ({ value: r.command, label: r.label, detail: r.detail })),
      ]);
    }
    if (head === "/effort") {
      return take(effortRows());
    }
    // NOTE: /resume has NO argument autocomplete on purpose — submitting it opens the
    // interactive sessions panel (↑↓ · ⏎), so a second session-list dropdown here
    // would just duplicate it (that double-list was the confusing part).
    return [];
  };
  // Rows for the status-bar click pickers. Reuses the exact data the slash
  // pickers use, so selecting a row submits the same `/model X` / `/effort Y`
  // command path (notices, effort clamping, subscription handling all apply).
  const quickPickerRows = (which: "model" | "effort"): PaletteRow[] =>
    which === "model" ? commandPickerRows("/model") : effortRows();
  const isExactSlashCommand = (draft: string): boolean => {
    const q = draft.trim();
    if (!/^\/\S+$/.test(q)) return false;
    return matchCommands(q).some((c) => c.name === q);
  };

  // Read per render, NOT memoized at mount: gitBranch carries a 5s TTL cache
  // (plus invalidateGitBranch after /commit and /worktree use), so the status
  // bar follows branch switches instead of lying until restart.
  const branch = gitBranch();
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

  // Live subscription usage — the EXACT 5h/weekly % the -p/exec stream omits when
  // comfortably within limits. The vendor CLI fetches its own usage (its own token,
  // as designed) and we read the result: Codex from the rollout it already writes
  // (FREE), Claude via a tiny statusLine probe (one cheap turn). Runs only while the
  // /cost strip is open, and probes the ACTIVE account immediately on open AND on
  // every switch (instant feedback). Best-effort; no vendor token is ever read.
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
    const active = list.find((a) => a.id === activeCli?.id) ?? list[0];
    void probeOne(active); // instant feedback for the visible account
    const codexTimer = setInterval(() => { for (const a of subs()) if (a.auth.kind === "cli" && a.auth.binary.includes("codex")) void probeOne(a); }, 90_000);
    const claudeTimer = setInterval(() => { for (const a of subs()) void probeOne(a); }, 10 * 60_000);
    return () => { alive = false; clearInterval(codexTimer); clearInterval(claudeTimer); };
  }, [statusPinned, activeCli?.id]);

  // Reusable one-shot usage probe (xiii): the periodic probe above only runs while
  // the /usage strip is PINNED, so the first /usage (and inline /usage) used to show
  // the seeded "ok" forever. Callable from boot + the /usage command so real 5h/7d
  // % appear without pinning. Best-effort (needs python3 + an authed config dir).
  const probeAccountUsage = useCallback(async (a: Account | undefined) => {
    if (!a || a.exec !== "cli" || a.auth.kind !== "cli") return;
    setProbing((p) => { const n = new Set(p); n.add(a.id); return n; });
    try {
      const snaps = await probeUsage(a);
      if (snaps?.length) { recordRateLimits(a.id, snaps, { replace: true }); bumpUsage(); }
    } catch { /* best-effort; fall back to stream data */ }
    finally { setProbing((p) => { const n = new Set(p); n.delete(a.id); return n; }); }
  }, []);

  // Probe each subscription once at launch so the FIRST /usage shows real numbers.
  useEffect(() => {
    for (const a of listAccounts().filter((x) => x.enabled && x.exec === "cli" && x.auth.kind === "cli")) void probeAccountUsage(a);
  }, [probeAccountUsage]);
  // Memoized: this reads accounts.json + ~/.aws creds AND spawns `which claude`/
  // `which codex` subprocesses — doing that on every render (every scroll frame /
  // drag event) was a major source of input lag. Recompute only when the account
  // set could have changed: any command/turn changes items.length, a switch changes
  // activeCli, a probe/turn bumps usageTick. Never on scroll/drag or stream deltas.
  const onboardingState = useMemo(
    () => ({
      configured: listAccounts(),
      importable: importableEnvCreds(),
      cloudImportable: importableCloudCreds().map((c) => ({ provider: c.provider, label: c.label, source: c.source })),
      hasClaudeCli: Boolean(which("claude")),
      hasCodexCli: Boolean(which("codex")),
    }),
    [items.length, activeCli?.id, usageTick], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const setupRequired = needsOnboarding(onboardingState);
  setupRequiredRef.current = setupRequired;
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
  // Routing POLICY for the input box (intent, not a model name). Derived from the
  // live selector: a subscription pins the seat, a FixedSelector is an explicit
  // model pin, otherwise the RoutingSelector auto-routes per task.
  const selectorKind: SelectorKind = activeCli ? "subscription" : selector instanceof FixedSelector ? "fixed" : "routing";
  // Omit the policy line during onboarding — the setup splash already conveys the
  // state, and the extra row isn't worth crowding the first-run screen.
  const composerPolicy: string | undefined = setupRequired
    ? undefined
    : policyLabel({ selectorKind, pinnedModelLabel: model?.label, subscriptionLabel: activeCli?.label, mode });
  // Footer-right of the composer hint line: `provider` (dim) + `model` (bold).
  // On a subscription the label already carries the account, so provider is omitted.
  // Fullscreen has the METER as the single model line (one row below the
  // composer) — the footer-right model shows only in INLINE mode, which has no
  // meter. One fact, one place.
  const composerProvider = setupRequired || activeCli || fullscreen ? null : model?.provider ?? null;
  const composerModelName = setupRequired || fullscreen ? null : modelLabel;
  // Compact identity for the top-right corner: "claude · Max · you@host" for a
  // subscription (id stays the slug under the hood), else nothing.
  const bannerAccount = (() => {
    if (setupRequired || !activeCli) return null;
    const a = getAccount(activeCli.id);
    const name = (activeCliRef.current?.binary?.includes("codex") ? "chatgpt" : "claude");
    const idy = a?.identity?.label ?? "";
    const tier = (idy.match(/\b(Max|Pro|Plus|Team|Enterprise)\b/i) ?? activeCli.label.match(/\b(Max|Pro|Plus|Team|Enterprise)\b/i))?.[1];
    const email = idy.match(/[^\s·]+@[^\s·]+/)?.[0];
    return [name, tier, email].filter(Boolean).join(" · ");
  })();
  bannerAccountRef.current = bannerAccount;
  const routing = setupRequired || activeCli ? null : (lastPick?.reason ?? choice?.reason ?? null);
  // Context window of whatever's actually answering: the in-loop model, or — on a
  // subscription — the CLI's window. Claude Code Max runs a 200k window (NOT the
  // registry's 1M API value), so default claude to 200k; codex keeps its larger one.
  const activeCtxWindow = activeCli
    ? (activeCliRef.current?.binary?.includes("codex") ? (findModel(activeCliModel ?? "")?.contextWindow ?? 272_000) : 200_000)
    : model?.contextWindow ?? null;
  const ctxPct = !setupRequired && activeCtxWindow && lastInput > 0 ? Math.round((lastInput / activeCtxWindow) * 100) : null;
  // Mirror exactly what the status bar renders (model + cost + where + chips),
  // so every click zone matches the rendered position.
  const sbWhere = collapsePath(rootRef.current) + (branch ? `:${branch}` : "");
  const sbChips = [...(!online ? ["⚠ offline"] : []), ...(yolo ? ["yolo"] : [])];
  const sbChipLen = sbChips.reduce((n, c) => n + c.length, 0) + Math.max(0, sbChips.length - 1) * 2 + (sbChips.length ? 2 : 0);
  statusBarRenderRef.current = { model: modelLabel, costText: formatStatusCost(estimateCost(sessionRef.current.turns)), ctxPct, width, where: sbWhere, chipLen: sbChipLen };

  const push = (it: Item) => setItems((prev) => [...prev, it]);
  const pushPhase = (label: string, detail?: string) => {
    const id = idRef.current++;
    push({ kind: "phase", id, label, detail, state: "running" });
    return id;
  };
  const updatePhase = (id: number, state: "running" | "ok" | "err", label: string, detail?: string) => {
    setItems((prev) => prev.map((it) => (it.id === id && it.kind === "phase" ? { ...it, state, label, detail } : it)));
  };
  const turnNoRef = useRef(0); // numbered sections: real prompts only (command echoes stay small)
  const echo = (text: string, numbered = false) => push({ kind: "user", id: idRef.current++, text, turnNo: numbered ? ++turnNoRef.current : undefined });
  const notice = (text: string) => push({ kind: "notice", id: idRef.current++, text });

  // Surface an auto-routing hop between a metered API account and a subscription
  // seat (or between accounts). The seat preference itself is by design — a seat
  // you already pay for is ~$0 until its window fills — but a silent switch
  // reads as a bug, so name it the moment it happens. Pins skip this (the user
  // chose explicitly); failover hops narrate themselves.
  const noteBackendSwitch = (choice: ModelChoice) => {
    const next = backendKeyOf(choice.backend);
    const prev = lastBackendRef.current;
    lastBackendRef.current = next;
    if (!prev || (prev.kind === next.kind && prev.accountId === next.accountId)) return;
    if (next.kind === "cli") notice(`↳ switched to the ${choice.model.label} seat (subscription · ~$0 marginal) — /why for the scorecard`);
    else if (prev.kind === "cli") notice(`↳ switched to ${choice.model.label} via the ${choice.model.provider} API — /why for the scorecard`);
    else notice(`↳ switched account: ${choice.model.label} via ${choice.model.provider} — /why for the scorecard`);
  };

  const handleAddResult = async (account: Account, initialMessage: string) => {
    notice(`${initialMessage} · testing…`);
    const t = await testAccount(account);
    notice(t.ok ? `✓ added · ${t.message}` : `added, but the key test failed: ${t.message}`);
    const d = await discoverModels(account);
    if (d.models.length) {
      putAccount({ ...account, models: d.models });
      notice(`found ${d.models.length} model${d.models.length === 1 ? "" : "s"} on this account · /model to pick one`);
    } else if (d.note) {
      notice(d.note);
    }
    const mspec = d.models.map((id) => findModel(id)).find(Boolean) ?? modelRegistry().find((m) => m.provider === account.provider);
    if (mspec) notice(`this account can: ${capabilitySummary(mspec)}`);
  };

  const pushAccounts = (view: AccountView) => push({ kind: "accounts", id: idRef.current++, view });

  const normalizeAccountRef = (s: string) =>
    s.toLowerCase()
      .replace(/[()]/g, " ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const accountAliases = (a: ReturnType<typeof listAccounts>[number]) => {
    const name = accountName(a);
    const slug = accountSlug(a);
    const aliases = new Set([slug, normalizeAccountRef(name), normalizeAccountRef(a.label), normalizeAccountRef(a.id)]);
    const nick = name.match(/\(([^)]+)\)/)?.[1];
    if (nick) aliases.add(normalizeAccountRef(nick));
    if (a.provider === "codex-cli") aliases.add("chatgpt");
    if (a.provider === "claude-cli") aliases.add("claude");
    return aliases;
  };
  const findAccountRef = (query: string, accounts = listAccounts()): { account?: (typeof accounts)[number]; error?: string } => {
    const q = normalizeAccountRef(query);
    if (!q) return { error: "which account? use /account <name>" };
    const exact = accounts.map((a) => ({ a, aliases: accountAliases(a) })).filter(({ aliases }) => aliases.has(q));
    if (exact.length === 1) return { account: exact[0]!.a };
    if (exact.length > 1) return { error: `"${query}" matches ${exact.map(({ a }) => accountName(a)).join(", ")} · use the full alias` };
    const fuzzy = accounts.map((a) => ({ a, aliases: [...accountAliases(a)] })).filter(({ aliases }) => aliases.some((x) => x.includes(q)));
    if (fuzzy.length === 1) return { account: fuzzy[0]!.a };
    if (fuzzy.length > 1) return { error: `"${query}" matches ${fuzzy.map(({ a }) => accountName(a)).join(", ")} · use the full alias` };
    return { error: `no account matching "${query}"` };
  };
  const buildAccountView = (
    accounts: ReturnType<typeof listAccounts>,
    activeCliId: string | null,
    importable: { provider: string; label: string; envVar: string }[],
    statuses: Record<string, { signedIn?: boolean; detail?: string; duplicateOf?: string; identity?: string }>,
  ): AccountView => {
    const active = activeCliId ? accounts.find((a) => a.id === activeCliId) : null;
    const rows = accounts.map((a) => {
      const st = statuses[a.id];
      const activeRow = a.id === activeCliId;
      const status =
        activeRow ? "active" :
        st?.duplicateOf ? "duplicate" :
        st?.signedIn === false ? "not signed in" :
        st?.signedIn === true ? "signed in" :
        a.exec === "cli" ? "not checked" :
        badgeFor(a.health?.state);
      return {
        name: accountName(a),
        type: (a.exec === "cli" ? "subscription" : "API key") as "subscription" | "API key",
        status,
        active: activeRow,
        alias: accountSlug(a),
        // Who/what this account is · live sign-in detail (email · plan) if we just
        // checked, else the identity we persisted on a prior login. Lets the user
        // tell which Claude/ChatGPT account a subscription seat actually is.
        detail: (st?.signedIn ? st.detail : undefined) ?? a.identity?.label,
        duplicateOf: st?.duplicateOf,
        health: a.health?.state,
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

  // Refresh each subscription account's live identity (email · plan) into the
  // status cache, persisting the email when the CLI exposes one so it survives
  // future checks. Called when the /account panel opens so the user can see WHICH
  // Claude/ChatGPT account a seat is · not just "subscription".
  const refreshCliStatuses = useCallback(async () => {
    const accounts = listAccounts().filter((a) => a.exec === "cli");
    const statuses = { ...accountStatusCacheRef.current };
    await Promise.all(accounts.map(async (a) => {
      const bin = (a.auth as any).binary as string;
      const profile = (a.auth as any).loginProfile as string | undefined;
      try {
        const st = await cliAuthStatus(bin, profile);
        statuses[a.id] = { signedIn: st.loggedIn, detail: st.detail, identity: st.identity };
        if (st.loggedIn && st.identityLabel) {
          putAccount({ ...a, identity: { key: st.identity ?? a.id, label: st.identityLabel, checkedAt: Date.now() } });
        }
      } catch { /* keep prior status */ }
    }));
    accountStatusCacheRef.current = statuses;
  }, []);

  // Set for the next turn to route it through the docs-grounded /ask path.
  const askModeRef = useRef(false);
  // Provenance is shown in full only when the route CHANGES (a switch, a model
  // change, a failover hop) · not on every unchanged turn. `routeChanged` returns
  // true the first time it sees a given (backend·account·model) key.
  const lastRouteRef = useRef("");
  const routeChanged = (key: string) => {
    const changed = key !== lastRouteRef.current;
    lastRouteRef.current = key;
    return changed;
  };

  // Run a turn through a vendor subscription binary (claude/codex). Shared by the
  // EXPLICIT pin (`/account use`) and an AUTO-routed seat the RoutingSelector
  // chose · the dispatch is the same; only where the seat came from differs.
  const runCliBackend = useCallback(
    async (args: {
      binary: string;
      profile?: string;
      modelId?: string; // the sdk model id the binary understands (no cli: prefix)
      accountId: string;
      efforts: string[];
      label?: string; // model label for the phase line
      pinned: boolean; // true ⇒ explicit pin (no routing reason to show)
      deferTerminal?: boolean; // caller drives failover: suppress terminal events, return failure
      showProvenance?: boolean; // emit the "using subscription · …" line (only when the route changed)
      prompt: string;
      messages: ModelMessage[];
      onEvent: OnEvent;
      signal?: AbortSignal;
    }): Promise<{ messages: ModelMessage[]; usage: { inputTokens: number; outputTokens: number }; failure?: { message: string } }> => {
      const { binary, profile, modelId, accountId, efforts, label, pinned, prompt, messages, onEvent, signal } = args;
      usedAccountRef.current = accountId;
      // Full provenance only when the route just changed; unchanged turns stay quiet
      // (the working strip + reply are enough · no per-turn "owns tools" repetition).
      if (args.showProvenance !== false) {
        const detail = pinned
          ? `${binary}${label ? ` · ${label}` : ""} owns tools and permissions`
          : `${binary}${label ? ` · ${label}` : ""} subscription seat · own tools/permissions`;
        onEvent({ type: "phase", label: "using subscription", detail, state: "running" });
      }
      // Effort is validated against THIS model's supported set and CLAMPED/omitted,
      // never thrown — a mismatch must not kill a subscription turn (S-E; mirrors the
      // in-loop R-4 fix). (Note: the claude CLI doesn't take an effort flag yet, so
      // for claude this clamps then gets dropped downstream in buildCliArgs.)
      let cliEffort = normalizeEffort(effortRef.current, efforts) ?? undefined;
      if (cliEffort === undefined && effortRef.current !== "medium" && efforts.length) {
        const { level: nearest } = clampEffort(effortRef.current, efforts);
        cliEffort = normalizeEffort(nearest, efforts) ?? undefined;
      }
      const activeAccount = getAccount(accountId);
      const activeName = activeAccount ? accountName(activeAccount).match(/\((.*)\)/)?.[1] : undefined;
      const reloginCommand = binary.includes("codex")
        ? `/account add codex${activeName ? ` ${activeName}` : ""}`
        : `/account add claude${activeName ? ` ${activeName}` : ""}`;
      // On the first turn of a session, inject the repo map so the model doesn't
      // waste tool calls discovering structure. The CLI backend bypasses gearbox's
      // context engine entirely, so this is the only upfront structural context.
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
          // non-critical · proceed with plain prompt
        }
      }
      // Images (xiv): the vendor CLI can't take inline image content, but it CAN
      // read files, so hand it the absolute paths and ask it to open them — far
      // better than refusing the turn outright.
      if (activeImagesRef.current.length) {
        cliPrompt += `\n\n<attached-images>\n${activeImagesRef.current.map((img) => img.path).join("\n")}\n</attached-images>\nThe user attached the image file(s) listed above — open them with your file/read tools to view them.`;
      }
      const r = await runCliTask({
        binary,
        prompt: cliPrompt,
        messages,
        onEvent,
        signal,
        sessionId: cliSessionRef.current,
        autoApprove: isYolo(),
        profile,
        modelId,
        effort: cliEffort,
        accountLabel: activeAccount ? accountLabel(activeAccount) : accountId,
        reloginCommand,
        deferTerminal: args.deferTerminal,
      });
      cliSessionRef.current = r.sessionId ?? cliSessionRef.current;
      cliMetaRef.current = { costUSD: r.costUSD, rates: r.rates };
      // Surface the model the subscription CLI actually used (claude reports it in
      // its stream) when the user hasn't pinned one, so the status bar shows e.g.
      // "Claude (personal) · sonnet-4.6" instead of just the account name.
      if (r.model && !activeCliModelRef.current && !args.label) setActiveCliModel(cliModelLabel(r.model));
      // WIRE TRUTH for subscription turns: the CLI stream reports the model that
      // actually served the turn — feed it to the same cross-check the in-loop
      // path uses, so a subscription seat can never silently serve a different
      // model than the routing line claims.
      servedModelRef.current = r.model ?? null;
      return { messages: r.messages, usage: r.usage, failure: r.failure };
    },
    [],
  );

  const defaultRunner: Runner = useCallback(
    async ({ prompt, messages, onEvent, selector: sel, signal, escalate = 0 }) => {
      // /ask (and auto-detected meta-questions): answer from the bundled Gearbox
      // docs, NO tools. The session's pin is honored (the pinned model answers);
      // fresh routing is the fallback when the pin can't serve. Read-and-clear.
      const isAsk = askModeRef.current;
      askModeRef.current = false;
      // Wire truth is per-turn: clear the previous turn's served-model id so a
      // path that doesn't report one (e.g. /ask via runCompletion) can never
      // show a stale ✓wire/mismatch from an earlier turn.
      servedModelRef.current = null;
      if (isAsk) {
        const docs = loadGearboxDocs();
        if (!docs) {
          onEvent({ type: "error", message: "Gearbox docs aren't bundled with this install · can't answer from them." });
          return { messages, usage: { inputTokens: 0, outputTokens: 0 } };
        }
        // Honor the session's pin: a /model-pinned model answers its own
        // meta-questions. Routing around the pin here surprised users (a pinned
        // Azure model's "what model are you" ran on a claude seat) AND
        // misattributed the provenance line. Fresh routing is only the fallback
        // when the pinned selector can't produce a choice.
        let choice: ModelChoice;
        try {
          choice = sel.select({ prompt, kind: "search" });
        } catch {
          choice = new RoutingSelector().select({ prompt, kind: "search" });
        }
        routedKindRef.current = { kind: "search", source: "ask" }; // /why after an /ask turn shows what actually ran
        if (!activeCliRef.current && sel instanceof RoutingSelector) noteBackendSwitch(choice);
        // The session digest grounds meta-questions about THIS conversation
        // ("which model answered my last question") in real per-turn records.
        const session = sessionDigest(messages, sessionRef.current.turns);
        // On a subscription (no in-loop API), run the grounded answer THROUGH the
        // CLI seat instead of refusing — prepend the docs so it stays grounded and
        // tell the binary not to use tools. (vi)
        const askCli = activeCliRef.current ?? (choice.backend?.kind === "cli" ? { binary: choice.backend.binary, id: choice.backend.account.id, label: choice.model.label, profile: choice.backend.profile, sdkId: choice.model.sdkId } : null);
        if (askCli) {
          const askPrompt = `${buildAskSystem(docs, session)}\n\nAnswer the following question about Gearbox using ONLY the reference above. Do not use any tools.\n\nQuestion: ${prompt}`;
          // Keep the per-turn provenance truthful: the routing line reads
          // routedRef after the turn, so a stale pick from an EARLIER turn here
          // reported the wrong model + a phantom wire mismatch. An explicit
          // subscription pin renders via activeCliModelRef (routedRef stays
          // null, like the pin branch below); a routed seat records its pick.
          routedRef.current = activeCliRef.current ? null : { model: choice.model, reason: choice.reason };
          if (!activeCliRef.current) setLastPick({ model: choice.model, reason: choice.reason });
          usedAccountRef.current = (askCli as any).id;
          cliMetaRef.current = null;
          const r = await runCliBackend({ binary: (askCli as any).binary, profile: (askCli as any).profile, modelId: (askCli as any).sdkId ?? activeCliModelRef.current, accountId: (askCli as any).id, efforts: [], label: (askCli as any).label, pinned: true, deferTerminal: false, showProvenance: true, prompt: askPrompt, messages: [], onEvent, signal });
          return { messages, usage: r.usage };
        }
        routedRef.current = { model: choice.model, reason: choice.reason };
        setLastPick({ model: choice.model, reason: choice.reason }); // keep the status bar honest about what /ask ran (R-1)
        onEvent({ type: "model-pick", model: choice.model.label, provider: choice.model.provider, reason: choice.reason });
        const acct = (choice.backend?.kind === "in-loop" && choice.backend.account) || defaultAccount(choice.model.provider);
        const creds = acct ? await resolveCreds(acct) : undefined;
        usedAccountRef.current = acct?.id ?? null;
        cliMetaRef.current = null;
        if (acct) markUsed(acct.id);
        const r = await runCompletion({ model: choice.model, system: buildAskSystem(docs, session), prompt, onEvent, signal, creds, maxRetries: onlineRef.current ? 2 : 0 });
        return { messages, usage: r.usage };
      }
      const imagesPresent = activeImagesRef.current.length > 0;

      // An EXPLICIT subscription pin (`/account use`) bypasses routing entirely.
      // Images now flow to the CLI as file paths (see cliPrompt above), so we no
      // longer refuse them here (xiv).
      const pin = activeCliRef.current;
      // Re-check the pinned account is still enabled: a disabled CLI subscription
      // must NOT keep executing turns (it bypasses routing/health/failover). If it
      // was disabled mid-session, drop the pin and fall through to normal routing.
      if (pin && getAccount(pin.id)?.enabled === false) activeCliRef.current = null;
      if (pin && activeCliRef.current) {
        routedRef.current = null;
        cliMetaRef.current = null;
        const choices = cliModelChoices(pin.binary);
        const cliChoice = choices.find((m) => m.id === activeCliModelRef.current) ?? choices[0];
        return runCliBackend({
          binary: pin.binary, profile: pin.profile, modelId: activeCliModelRef.current, accountId: pin.id,
          efforts: cliChoice?.efforts ?? [], label: cliModelLabel(activeCliModelRef.current) || undefined,
          pinned: true, showProvenance: routeChanged(`pin:${pin.id}:${activeCliModelRef.current ?? pin.binary}`), prompt, messages, onEvent, signal,
        });
      }

      const plan = modeRef.current === "plan";
      const requires: ModelRequirement[] = ["tools", ...(imagesPresent ? ["images" as const] : [])];

      // Emit the terminal events the inner runners deferred, for the FINAL outcome
      // (mirrors run.ts: error → blocked → done, or finished → done). One per turn.
      const emitTerminal = (errored: boolean, message: string | undefined, usage: { inputTokens: number; outputTokens: number }) => {
        if (errored && message) onEvent({ type: "error", message });
        onEvent({ type: "phase", label: errored ? "blocked" : "finished", state: errored ? "err" : "ok" });
        onEvent({ type: "done", usage });
      };

      // Run ONE attempt of a chosen backend (terminal events deferred so the loop
      // owns the final outcome). Returns the produced ledger + a cooldown key so a
      // failure can park that account and re-route around it.
      type Attempt = { messages: ModelMessage[]; usage: Usage; failure?: { message: string; producedOutput?: boolean }; cooldownKey: string };
      const runAttempt = async (choice: ModelChoice): Promise<Attempt> => {
        servedModelRef.current = null; // each attempt re-establishes its own wire truth (failover hops must not inherit)
        if (choice.backend?.kind === "cli") {
          const acct = choice.backend.account;
          // Images flow to the CLI as file paths now (xiv) — no refusal here.
          routedRef.current = { model: choice.model, reason: choice.reason };
          setLastPick({ model: choice.model, reason: choice.reason });
          const showCli = routeChanged(`cli:${acct.id}:${choice.model.id}`);
          if (showCli) onEvent({ type: "model-pick", model: choice.model.label, provider: choice.model.provider, reason: choice.reason });
          const out = await runCliBackend({
            binary: choice.backend.binary, profile: choice.backend.profile, modelId: choice.model.sdkId, accountId: acct.id,
            efforts: choice.model.efforts ?? [], label: choice.model.label,
            pinned: false, deferTerminal: true, showProvenance: showCli, prompt, messages, onEvent, signal,
          });
          // The CLI's failure carries no producedOutput flag; an assistant message
          // in the returned ledger means text already streamed to the user.
          const cliProduced = out.messages.length > 0 && out.messages[out.messages.length - 1]!.role === "assistant";
          return { messages: out.messages, usage: out.usage, failure: out.failure ? { ...out.failure, producedOutput: cliProduced } : undefined, cooldownKey: acct.id };
        }

        const missing = missingRequirements(choice.model, requires);
        if (missing.length) throw new Error(`${choice.model.label} cannot run this turn (${missing.join(", ")} unsupported). Use /model auto or pick a compatible model.`);
        routedRef.current = { model: choice.model, reason: choice.reason };
        setLastPick({ model: choice.model, reason: choice.reason });
        if (routeChanged(`api:${choice.model.provider}:${choice.model.id}`)) {
          onEvent({ type: "model-pick", model: choice.model.label, provider: choice.model.provider, reason: choice.reason });
        }
        onEvent({ type: "phase", label: "building context", detail: choice.model.label, state: "running" });
        const userContent = imageContent(prompt, activeImagesRef.current);
        let { system, messages: ctx, cacheBreak, sections } = buildContext({ history: messages, userText: prompt, userContent, model: choice.model, plan, cwd: rootRef.current });
        // Remember this turn's non-history context overhead (system + memory +
        // repomap + retrieval + git) so the auto-compact trigger can budget on
        // the FULL context, not history alone.
        ctxOverheadRef.current = sections.filter((s) => s.name !== "history" && s.name !== "user").reduce((a, s) => a + s.tokens, 0);
        if (agentDef) system = `${system}\n\n# ACTIVE AGENT: ${agentDef.name}\n${agentDef.system}`;
        const account = (choice.backend?.kind === "in-loop" && choice.backend.account) || defaultAccount(choice.model.provider);
        const creds = account ? await resolveCreds(account) : undefined;
        usedAccountRef.current = account?.id ?? null;
        cliMetaRef.current = null;
        if (account) markUsed(account.id);
        let _effortRaw = normalizeEffort(effortRef.current, effortLevels(choice.model));
        if (_effortRaw === null && effortRef.current !== "medium") {
          // The (often auto-routed) model doesn't support the active effort tier.
          // CLAMP to the nearest supported level instead of throwing — routing
          // picking a model with a different effort vocab must not kill the turn (R-4).
          const supported = effortLevels(choice.model);
          if (supported.length) {
            const { level: nearest, clamped } = clampEffort(effortRef.current, supported);
            _effortRaw = nearest;
            if (clamped) onEvent({ type: "phase", label: "effort clamped", detail: `${choice.model.label}: ${effortRef.current} → ${nearest}`, state: "running" });
          } // else: model has no effort control → omit effort (leave null)
        }
        const r = await runTask({
          model: choice.model, messages: ctx, onEvent, signal, plan, system, creds,
          root: rootRef.current, // tools stay rooted in THIS tab's tree even when another tab owns cwd
          effort: _effortRaw ?? undefined, deferTerminal: true, maxRetries: onlineRef.current ? 2 : 0,
          pinnedModelId: explicitModelId, cacheBreak,
          onBackground: (rep) => {
            // Surface NOW (notice + toast), deliver the full text next turn.
            push({ kind: "notice", id: idRef.current++, text: `background sub-task #bg${rep.id} ${rep.ok ? "finished" : "FAILED"} · ${rep.task.slice(0, 70)}\n${rep.text.split("\n").slice(0, 3).join("\n")}` });
            pendingBackgroundRef.current.push(`[background sub-task #bg${rep.id} · ${rep.ok ? "finished" : "failed"}]\nTask: ${rep.task}\nReport:\n${rep.text}`);
            toast(`background sub-task #bg${rep.id} ${rep.ok ? "done" : "failed"}`, rep.ok ? "ok" : "err");
          },
        });
        if (account && r.headers) {
          const apiRates = parseRateHeaders(account.provider, r.headers, Date.now());
          if (apiRates.length) cliMetaRef.current = { costUSD: undefined, rates: apiRates };
        }
        servedModelRef.current = r.servedModelId ?? null;
        const produced = r.messages.slice(ctx.length);
        const imageNote = activeImagesRef.current.length ? `\n\n[Attached images: ${activeImagesRef.current.map((img) => basename(img.path)).join(", ")}]` : "";
        const ledger = sanitizeToolPairs([...messages, { role: "user", content: prompt + imageNote }, ...produced]);
        return { messages: ledger, usage: r.usage, failure: r.failure, cooldownKey: account?.id ?? `env:${choice.model.provider}` };
      };

      // Reactive same-turn failover: try the routed pick; if it fails because the
      // account is out of quota/credit/rate, park it (the router then routes
      // around it), narrate plainly, re-select, and continue · up to MAX hops.
      const MAX_FAILOVERS = 2;
      // Intelligent routing: a cheap model classifies the task → the router sets the
      // right quality bar (e.g. "explain this regex" → chat → Haiku, not Sonnet).
      // Plan mode forces "plan"; a pinned model (FixedSelector) ignores kind, so we
      // only spend the classify call when auto-routing. Falls back to keyword internally.
      let routedKind: TaskKind | undefined = plan ? "plan" : undefined;
      // Honor an explicit in-prompt model directive ("use opus to …") under auto-
      // routing — the router only ever saw a task KIND, so "use opus" used to be
      // invisible and you'd get sonnet. A direct /model pin (FixedSelector) already
      // wins; this adds the natural-language path.
      const agentDef = agentTurnRef.current; // set by runTurn for @agent turns
      const directiveId = (agentDef?.model ?? null) || (sel instanceof RoutingSelector ? modelDirectiveIn(prompt) : null);
      let routedSource = "plan mode"; // only plan pre-sets routedKind; otherwise the classifier below decides
      if (!routedKind && sel instanceof RoutingSelector && !directiveId) {
        onEvent({ type: "phase", label: "routing", detail: "choosing a model", state: "running" });
        const cls = await classifyTask(prompt, signal);
        routedKind = cls.kind;
        routedSource = cls.source;
      }
      routedKindRef.current = routedKind ? { kind: routedKind, source: routedSource } : null;
      let choice: ModelChoice;
      try {
        // interactive: true — this is the foreground turn the user is waiting on, so
        // routing prefers a faster model among bar-clearing candidates (done > FAST >
        // cheap). Delegated sub-tasks and compaction omit it → they stay cheapest.
        choice = directiveId ? new FixedSelector(directiveId).select({ prompt, kind: routedKind, requires }) : sel.select({ prompt, kind: routedKind, requires, escalate, interactive: true });
      } catch {
        choice = sel.select({ prompt, kind: routedKind, requires }); // directive model unavailable → fall back to routing
      }
      if (sel instanceof RoutingSelector && !directiveId) noteBackendSwitch(choice);
      // When the user explicitly chose the model (a directive or a /model pin),
      // delegated sub-tasks inherit it instead of re-routing to the cheapest.
      const explicitModelId = directiveId || (sel instanceof FixedSelector ? choice.model.id : undefined);
      // Tokens a FAILED attempt already burned must still be counted (C-A) — they
      // hit the wire. Accumulate across hops so cost/ledger aren't under-counted.
      const prior: Usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0 };
      for (let hop = 0; ; hop++) {
        const a = await runAttempt(choice);
        // Cache read/write tokens ride along (they bill too) — dropping them on a
        // hop under-counted every failed attempt's real cost in the ledger.
        const total: Usage = {
          inputTokens: prior.inputTokens + a.usage.inputTokens,
          outputTokens: prior.outputTokens + a.usage.outputTokens,
          cachedInputTokens: (prior.cachedInputTokens ?? 0) + (a.usage.cachedInputTokens ?? 0),
          cacheCreationInputTokens: (prior.cacheCreationInputTokens ?? 0) + (a.usage.cacheCreationInputTokens ?? 0),
        };
        if (!a.failure) { emitTerminal(false, undefined, total); return { messages: a.messages, usage: total }; }
        prior.inputTokens = total.inputTokens; prior.outputTokens = total.outputTokens; // this attempt burned tokens too
        prior.cachedInputTokens = total.cachedInputTokens; prior.cacheCreationInputTokens = total.cacheCreationInputTokens;
        // Failover-able failure classes: exhausted (rate/quota/credit — recovers on
        // its own) and auth (expired/invalid — dead until re-login, but a sibling
        // account can serve). A failure AFTER output streamed never hops: the user
        // already saw a partial answer, and a silent re-run would duplicate it.
        const failKind = classifyFailure(a.failure.message);
        const canHop = failKind !== "other" && !a.failure.producedOutput;
        // R-5: scope the park to what actually failed. Billing/credit drains the
        // whole account, expired/invalid creds kill it entirely, and a CLI seat's
        // limit window is account-wide by construction (one plan spans every model
        // the binary serves — model-scoping it would burn all hops on dead sibling
        // seats before reaching a ready metered key). Only an in-loop API
        // rate/quota blip is scoped to the one model.
        const scope = failKind === "auth" || choice.backend?.kind === "cli" ? "account" : cooldownScope(a.failure.message);
        const parkedKey = scope === "account" ? a.cooldownKey : modelScopedKey(a.cooldownKey, choice.model.id);
        if (!canHop || hop >= MAX_FAILOVERS) {
          // Even when this turn can't hop (output already streamed / hop cap),
          // park the failed account so the NEXT turn routes around it instead
          // of marching straight back into the same wall.
          // Auth-dead accounts park for hours, not minutes — a 5-minute park just
          // meant the router marched back into the same dead account all day.
          if (failKind !== "other") markExhausted(parkedKey, failKind === "auth" ? AUTH_COOLDOWN_MS : DEFAULT_COOLDOWN_MS, a.failure.message);
          // "Deployment doesn't exist" on Azure/Foundry: prune that model id from
          // the account so it never shows up again. User can redeploy + /account refresh to restore.
          if (isNotDeployedError(a.failure.message) && !a.cooldownKey.startsWith("env:")) {
            const acc = getAccount(a.cooldownKey);
            if (acc?.models?.includes(choice.model.sdkId)) {
              putAccount({ ...acc, models: acc.models.filter((m) => m !== choice.model.sdkId) });
              notice(`${choice.model.label} isn't deployed on ${acc.slug ?? acc.id} — removed from your model list.\nDeploy it in your Azure portal, then /account refresh to restore it.`);
            }
          }
          // A turn that died before ANY output must not commit its dangling user
          // message — the next turn would append another user message and every
          // provider 400s on consecutive user roles, poisoning the whole session.
          // Output streamed → keep the partial (user → partial assistant is legal).
          emitTerminal(true, a.failure.message, prior);
          return { messages: a.failure.producedOutput ? a.messages : messages, usage: prior };
        }
        markExhausted(parkedKey, failKind === "auth" ? AUTH_COOLDOWN_MS : DEFAULT_COOLDOWN_MS, a.failure.message);
        let next: ModelChoice | null = null;
        try { next = sel.select({ prompt, kind: routedKind, requires }); } catch { next = null; }
        const nextAcct = next?.backend?.kind === "cli" ? next.backend.account.id : next?.backend?.kind === "in-loop" && next.backend.account ? next.backend.account.id : next ? `env:${next.model.provider}` : null;
        // Bail only when the router hands back the exact pick we just parked
        // (its zero-candidates fallback) — the same account on a DIFFERENT model
        // is a legitimate hop now that parks can be model-scoped.
        const nextEffectiveKey = next && nextAcct ? (scope === "account" ? nextAcct : modelScopedKey(nextAcct, next.model.id)) : null;
        if (!next || nextEffectiveKey === parkedKey) {
          emitTerminal(true, a.failure.message, prior);
          // Same no-dangling rule as the no-hop bail above.
          return { messages: a.failure.producedOutput ? a.messages : messages, usage: prior };
        }
        onEvent({ type: "phase", label: "failover", detail: `${choice.model.label} ${shortFailure(a.failure.message)} → ${next.model.label}, continuing`, state: "running" });
        // Remember what we fell back FROM so the post-turn routing line can flag the
        // provider fallback (a real "surprising" signal) in amber.
        fellOverFromRef.current = choice.model.label;
        // Track the hopped-to backend silently — the failover line above already
        // narrates the switch, but the NEXT turn's comparison must start from
        // what actually served this one.
        lastBackendRef.current = backendKeyOf(next.backend);
        choice = next;
      }
    },
    [],
  );

  // Summarize older turns (cheap model via the selector seam · kind:"summarize")
  // and rewrite msgRef in place. The visible transcript (items) is untouched;
  // only the model's working context shrinks. Returns a status line for a notice.
  const compactNow = useCallback(
    async (keepRecent: number, signal?: AbortSignal): Promise<string> => {
      // Apply a successful compaction (either path) and report real numbers.
      const apply = (res: { messages: ModelMessage[]; summarizedTurns: number; before: number; after: number; how: string }, how: string): string => {
        msgRef.current = res.messages;
        // The status bar's ctx% reads lastInput from the LAST call — after
        // compaction that's stale (it kept showing the pre-compaction size).
        // Reset to history + the non-history overhead (system/memory/repomap/
        // retrieval) — history alone showed a falsely roomy bar after /compact.
        setLastInput(res.after + ctxOverheadRef.current);
        const saved = res.before - res.after;
        const savedStr = saved >= 1000 ? `${(saved / 1000).toFixed(1)}k` : String(Math.max(0, saved));
        // res.how carries the truth per rung (summarized/elided/truncated) —
        // summarizedTurns is 0 on the tool-result-truncation rung.
        return `${res.how}${how} · ~${savedStr} tokens freed (was ~${Math.round(res.before / 1000)}k, now ~${Math.round(res.after / 1000)}k)`;
      };
      // The model-free fallback: mechanical elision (tool output distilled to
      // one line per call). /compact must ALWAYS be able to shrink the history,
      // even on a subscription-only session with no API-key summarizer.
      const mechanical = (why: string): string => {
        const res = elideHistory(msgRef.current, keepRecent);
        // null now genuinely means nothing-to-shrink at ANY rung of the ladder.
        if (!res) return `${why} · history is already minimal — nothing to compact`;
        return apply(res, ` (${why})`);
      };
      let model, creds;
      try {
        const ch = selectorRef.current.select({ prompt: "", kind: "summarize" });
        // The summarizer runs in-loop (AI SDK), so a flat-rate seat can't host it.
        if (ch.backend?.kind === "cli") return mechanical("no API-key summarizer on a subscription");
        model = ch.model;
        // Resolve the model's account creds so compaction works for STORED API
        // accounts, not just an env key (it silently never compacted before).
        const acct = (ch.backend?.kind === "in-loop" && ch.backend.account) || defaultAccount(model.provider);
        creds = acct ? await resolveCreds(acct) : undefined;
      } catch {
        return mechanical("no model available");
      }
      let res;
      try {
        res = await compactHistory({ history: msgRef.current, summarize: modelSummarizer(model, creds, signal), keepRecent });
      } catch (e: any) {
        return mechanical(`summarizer failed on ${model.label}: ${e?.message ?? "error"}`);
      }
      if (!res) return "history is already minimal — nothing to compact";
      return apply(res, "");
    },
    [],
  );

  // Mode changes are SILENT in the transcript (cycling shift+tab used to spam a
  // notice line per press): the composer wears the mode — colored edges + a
  // footer badge (plan green · auto-accept amber) — and that's the whole story.
  const setModeTo = (next: "normal" | "auto-accept" | "plan") => {
    modeRef.current = next;
    setMode(next);
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
    if (!allowed.length) return ` · effort reset to ${level} (no reasoning support)`;
    return ` · effort clamped: ${prev} → ${level} (${prev} not supported)`;
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
    toast(`effort → ${level} · ${target.label}`);
  };

  // Hand the terminal to an interactive child (e.g. `claude auth login`'s OAuth
  // flow): drop raw mode + leave the alt-screen so the child owns the TTY,
  // run it synchronously (Ink is frozen meanwhile, so it can't steal stdin), then
  // restore our screen. Returns the child's exit code (or null if it couldn't run).
  const runInteractive = (cmd: string, cmdArgs: string[], env?: Record<string, string>): number | null => {
    try {
      setRawMode?.(false);
      if (fullscreen && process.env.GEARBOX_MOUSE !== "0") process.stdout.write("\x1b[?1006l\x1b[?1002l\x1b[?1000l"); // mouse off (fullscreen-only — matches cli.tsx)
      if (fullscreen) process.stdout.write("\x1b[?1049l"); // leave alt-screen
      process.stdout.write("\x1b[?2004l\x1b[?25h"); // bracketed paste off, cursor on
      process.stdout.write(`\n→ running \`${cmd} ${cmdArgs.join(" ")}\` · follow the prompts…\n\n`);
      const r = nodeSpawnSync(cmd, cmdArgs, { stdio: ["inherit", "inherit", "inherit"], ...(env ? { env } : {}) });
      return r.status ?? 0;
    } catch {
      return null;
    } finally {
      if (fullscreen) process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");
      if (fullscreen && process.env.GEARBOX_MOUSE !== "0") process.stdout.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h"); // mouse back on (fullscreen-only)
      process.stdout.write("\x1b[?2004h\x1b[?25l"); // re-enable bracketed paste (and hide cursor) on return
      setRawMode?.(true);
    }
  };

  const runTurn = useCallback(
    async (prompt: string, attempt = 0) => {
      // One workshop phrase per turn; tool calls temporarily swap in the action
      // verb (Reading/Editing/Running) and restore this between calls.
      const turnVerb = nextVerb();
      setVerb(turnVerb);
      activeImagesRef.current = [];
      // `@<agent> task` runs the turn AS that agent: its system prompt rides the
      // context, its model (when set) pins the turn — everything else is the
      // normal machinery. Falls through harmlessly when @x isn't an agent name
      // (a leading @file mention still expands below).
      const agentInv = agentInvocation(prompt);
      agentTurnRef.current = agentInv?.agent ?? null;
      const effectivePrompt = agentInv ? agentInv.task : prompt;
      let { text: modelPrompt, attached } = expandMentions(effectivePrompt);
      // Backgrounded delegate reports arrive with the next turn — the model
      // requested the work and needs the result in context exactly once.
      if (pendingBackgroundRef.current.length) {
        modelPrompt = `${pendingBackgroundRef.current.join("\n\n")}\n\n---\n\n${modelPrompt}`;
        pendingBackgroundRef.current = [];
      }
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
      // Everything pushed from here on belongs to this turn; at settle we collapse
      // that slice (drop spinners, fold repeated checks) into a durable record.
      const turnStartId = idRef.current;
      echo(displayPrompt, true);
      lastPromptRef.current = displayPrompt;
      // Pre-flight hard spend cap (/cap): refuse the turn before any model call if
      // a configured ceiling is reached. Guards auto-fix re-entry and runaway spend
      // (parallel fan-out can multiply cost in one session).
      {
        const caps = capsRef.current;
        if (caps.session || caps.daily || caps.monthly || caps.total) {
          const verdict = checkCaps(caps, {
            session: estimateCost(sessionRef.current.turns),
            daily: totalSpentToday(),
            monthly: totalSpentThisMonth(),
            total: totalSpent(),
          });
          if (!verdict.allowed) {
            push({ kind: "error", id: idRef.current++, text: verdict.message ?? "spend cap reached" });
            return;
          }
        }
      }
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
      // Captured from the terminal `done` event so the post-turn timing line can
      // also surface the prompt-cache hit (proof caching is working).
      let turnUsage: Usage = { inputTokens: 0, outputTokens: 0 };
      outCharsRef.current = 0;
      firstOutputAtRef.current = 0;
      if (lingerRef.current) clearTimeout(lingerRef.current);
      setLinger(false);
      setMascotState("thinking");
      atBottomRef.current = true; // follow the live output
      if (!sessionRef.current.title) sessionRef.current.title = prompt.slice(0, 80);
      curAsstRef.current = null;
      const ac = new AbortController();
      abortRef.current = ac;
      const toolMap = new Map<string, number>();
      const pendingToolStreams = new Map<number, { arg?: string; activity?: string; delta: string; lines: number }>();
      let toolFlushTimer: ReturnType<typeof setTimeout> | null = null;
      // Assistant text is coalesced like tool streams: buffer deltas and flush on a
      // ~45ms timer instead of setItems-per-token. Per-token re-renders re-flatten
      // and repaint the whole screen, which is what makes streaming scroll jitter.
      let pendingText = "";
      let textFlushTimer: ReturnType<typeof setTimeout> | null = null;
      const changedFiles = new Set<string>();
      let turnChanges: FileChange[] = []; // pre-turn file snapshots, for /undo + /diff
      turnCheckpointRef.current = null; // each turn takes its own (lazily, on first mutation)
      const checks: string[] = [];
      const failures: string[] = [];
      let hadError = false;
      const flushText = () => {
        if (textFlushTimer) {
          clearTimeout(textFlushTimer);
          textFlushTimer = null;
        }
        if (!pendingText) return;
        const chunk = pendingText;
        pendingText = "";
        if (curAsstRef.current === null) {
          const id = idRef.current++;
          curAsstRef.current = id;
          setItems((prev) => [...prev, { kind: "assistant", id, text: chunk, done: false }]);
        } else {
          const id = curAsstRef.current;
          setItems((prev) => prev.map((i) => (i.id === id && i.kind === "assistant" ? { ...i, text: i.text + chunk } : i)));
        }
      };
      const finishAssistant = () => {
        flushText(); // commit any buffered text before marking the item done
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
            const base = { ...i, arg: p.arg ?? i.arg, activity: p.activity ?? i.activity };
            if (!p.delta) return base;
            const tail = ((i.stream ?? "") + p.delta).slice(-2400);
            return { ...base, stream: tail, streamCount: (i.streamCount ?? 0) + p.lines };
          }),
        );
      };
      const queueToolStream = (toolId: number | undefined, arg?: string, delta?: string, activity?: string) => {
        if (toolId == null) return;
        const prev = pendingToolStreams.get(toolId) ?? { delta: "", lines: 0 };
        const text = delta ?? "";
        pendingToolStreams.set(toolId, {
          arg: arg ?? prev.arg,
          activity: activity ?? prev.activity,
          delta: prev.delta + text,
          lines: prev.lines + (text.match(/\n/g) || []).length,
        });
        if (!toolFlushTimer) toolFlushTimer = setTimeout(flushToolStreams, 45);
      };

      const onEvent: OnEvent = (e) => {
        if (e.type === "model-pick") {
          // No transcript item here: the live model shows in the footer during the
          // turn, and the single canonical `routed → …` provenance line is printed
          // POST-turn (with the real cost) at the turn-completion seam below.
        } else if (e.type === "phase") {
          push({ kind: "phase", id: idRef.current++, label: e.label, detail: e.detail, state: e.state ?? "running" });
        } else if (e.type === "text") {
          setMascotState("streaming");
          if (firstOutputAtRef.current === 0) firstOutputAtRef.current = Date.now();
          outCharsRef.current += e.text.length;
          pendingText += e.text;
          if (!textFlushTimer) textFlushTimer = setTimeout(flushText, 45);
        } else if (e.type === "tool-start") {
          setMascotState("tool");
          setVerb(toolVerbFromName(e.name)); // the live verb names the running tool
          finishAssistant();
          const id = idRef.current++;
          toolMap.set(e.id, id);
          setItems((prev) => [...prev, { kind: "tool", id, callId: e.id, name: e.name, arg: e.arg, status: "running", summary: "", startedAt: Date.now() }]);
        } else if (e.type === "tool-stream") {
          const id = toolMap.get(e.id);
          queueToolStream(id, e.arg, e.delta, e.activity);
        } else if (e.type === "tool-output") {
          const id = e.id ? toolMap.get(e.id) : undefined;
          appendToolOutput(id, e.text);
        } else if (e.type === "tool-end") {
          setMascotState("thinking"); // back to reasoning until the next text/tool
          setVerb(turnVerb); // restore the turn's workshop phrase between tool calls
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
        } else if (e.type === "file-change") {
          void emitHook("file.edited", { path: e.path }).catch(() => {});
          turnChanges = recordChange(turnChanges, { path: e.path, before: e.before, existed: e.existed });
          changedFiles.add(e.path); // also drive the end-of-turn summary + verification (delegated edits arrive only as file-change events, not write-tool ends)
        } else if (e.type === "verification") {
          checks.push(e.command);
          if (!e.ok) failures.push(`${e.command}: ${e.summary}`);
          push({ kind: "verification", id: idRef.current++, command: e.command, ok: e.ok, summary: e.summary, intent: e.intent, durationMs: e.durationMs, output: e.output });
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
          turnUsage = e.usage;
          // The context % must reflect the WHOLE prompt sent, not just the uncached
          // slice — Anthropic reports cache read/write tokens separately, so using
          // inputTokens alone made ctx% collapse the moment caching kicked in (C-E).
          const totalIn = e.usage.inputTokens + (e.usage.cachedInputTokens ?? 0) + (e.usage.cacheCreationInputTokens ?? 0);
          if (totalIn > 0) setLastInput(totalIn);
          setTokens((t) => t + e.usage.inputTokens + e.usage.outputTokens);
        }
      };

      try {
        // Confidence-gated escalation: a fix attempt (attempt ≥ 1) tells the router
        // the cheap pick already missed, so it climbs to a stronger model instead of
        // re-running the too-weak one — fixing the false economy of a cheap pick that
        // fails and forces an expensive retry anyway.
        const r = await (runner ?? defaultRunner)({ prompt: modelPrompt, messages: msgRef.current, onEvent, selector: selectorRef.current, signal: ac.signal, escalate: attempt });
        msgRef.current = r.messages;
        if (verifyRef.current !== "off" && !hadError && !ac.signal.aborted && !interruptedRef.current && changedFiles.size && checks.length === 0) {
          // FAST tier first: language-server diagnostics on the changed files
          // (~1.5s settle, no test run). Type errors feed the same auto-fix
          // loop as a failed check, and a red here skips the slower shell
          // checks this round — fail fast, fix, then prove with real checks.
          const lspFailed = await runLspTier([...changedFiles], onEvent, (file, diags) => {
            // Attach to the LAST write/edit tool item that touched this file so
            // the diagnostics render under its diff.
            setItems((its) => {
              for (let i = its.length - 1; i >= 0; i--) {
                const t = its[i]!;
                if (t.kind === "tool" && (t.name.includes("write") || t.name.includes("edit") || t.name === "file_change") && t.arg && (t.arg === file || t.arg.endsWith("/" + file) || file.endsWith("/" + t.arg) || relPath(t.arg) === file)) {
                  const next = its.slice();
                  next[i] = { ...t, diagnostics: diags };
                  return next;
                }
              }
              return its;
            });
          });
          if (lspFailed) {
            hadError = true;
          } else {
            const commands = detectVerificationCommands(process.cwd(), [...changedFiles]);
            if (commands.length) {
              const results = await runVerification(commands, { onEvent, signal: ac.signal });
              if (results.some((res) => !res.ok)) hadError = true;
            } else {
              onEvent({ type: "phase", label: "verification skipped", detail: "no test/build/typecheck command detected", state: "err" });
            }
          }
        }
        // Record the turn's model + usage (routing/cost data; per-turn so the
        // router can vary the model later without changing this shape).
        // The model that actually ran this turn (set by defaultRunner). Falls
        // back to a fresh select only if a custom runner bypassed defaultRunner.
        // Prefer the routed MODEL id — activeCliRef.id is the account slug, which
        // used to land in ledger.jsonl/cost-tab as the "model" for subscription turns.
        let modelId = routedRef.current?.model.id ?? activeCliRef.current?.id;
        if (!modelId) {
          try {
            modelId = selectorRef.current.select({ prompt: lastPromptRef.current ?? "" }).model.id;
          } catch {
            modelId = "unknown";
          }
        }
        // Per-account spend ledger (ACCOUNT pillar): real cost when the provider
        // reports it (claude CLI), else an estimate from token usage × list price.
        // No stored account (env key) → ledger under `env:<provider>` so a
        // `/budget <provider>` actually depletes; falls back to the model id.
        const acctId = usedAccountRef.current ?? (findModel(modelId)?.provider ? `env:${findModel(modelId)!.provider}` : modelId);
        const cm = cliMetaRef.current;
        // Flat-rate subscription seats cost $0 marginal — the CLI's reported dollars
        // are the metered-equivalent (fictional here) and were inflating spend (S-F).
        const isSub = getAccount(acctId)?.exec === "cli";
        // ONE spend writer (ledger.ts): usage.json aggregates + the append-only
        // event log + the session TurnMeta all derive from this single event.
        const spendEv = recordSpend({
          accountId: acctId, model: modelId, source: "turn",
          inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens,
          cachedInputTokens: turnUsage.cachedInputTokens, cacheCreationInputTokens: turnUsage.cacheCreationInputTokens,
          ...resolveTurnCost({ modelId, isSub, cliCostUSD: cm?.costUSD, usage: { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, cachedInputTokens: turnUsage.cachedInputTokens, cacheCreationInputTokens: turnUsage.cacheCreationInputTokens } }),
          at: Date.now(),
          servedModel: servedModelRef.current ?? undefined,
        });
        sessionRef.current.turns.push(turnMetaOf(spendEv));
        // Session auto-title: after the FIRST turn, replace the clipped-prompt
        // placeholder with a real title from the cheap-model seam (fire-and-
        // forget; the heuristic title stays if generation can't run). /resume
        // stops being a wall of identical prompt prefixes.
        if (sessionRef.current.turns.length === 1) {
          const sid = sessionRef.current.id;
          void generateGitText(TITLE_SYSTEM, clipForPrompt(prompt, 600)).then((t) => {
            const title = t?.split("\n")[0]?.trim().replace(/^["'`]+|["'`.]+$/g, "").slice(0, 80);
            if (title && sessionRef.current.id === sid) {
              sessionRef.current.title = title;
              persist();
            }
          });
        }
        const cost = spendEv.costUSD;
        // The single canonical per-turn routing line: `routed → provider · model · cost`.
        // Every field is real — the model/provider that actually ran (routedRef tracks
        // failover), the same `cost` figure recorded just above ($0 ⇒ subscription seat),
        // the failover signal, AND confidence-gated escalation (the router appends
        // "· escalated after N failed checks" to the reason when a failed check pushed
        // the bar up to a stronger model — router.ts). Amber only on a real signal.
        if (modelId && modelId !== "unknown") {
          const ranSpec = routedRef.current?.model ?? findModel(modelId);
          // On an explicitly-pinned subscription, routedRef is null and modelId is the
          // ACCOUNT slug — resolve the real CLI model label instead of showing the slug.
          const pinnedSpec = isSub ? findModel(activeCliModelRef.current ?? "") : undefined;
          const subLabel = pinnedSpec?.label ?? activeCliModelRef.current;
          const line = buildRoutingLine({
            model: ranSpec?.label ?? (isSub ? (subLabel ?? modelId) : modelId),
            provider: isSub ? (activeCliRef.current?.binary?.includes("codex") ? "chatgpt" : "claude") : (ranSpec?.provider ?? "—"),
            costUSD: cost,
            kind: isSub ? "subscription" : "metered",
            priced: isSub || hasPricing(modelId),
            servedAs: servedModelRef.current ?? undefined,
            // What we actually asked the backend for: the routed pick's sdk id,
            // or — on an explicitly-pinned subscription — the pinned seat's model.
            // Undefined when no model was sent (CLI default); the routing line
            // then reports the wire id quietly instead of inventing a mismatch.
            requestedSdkId: ranSpec?.sdkId ?? pinnedSpec?.sdkId,
            fellOverFrom: fellOverFromRef.current,
            escalated: /escalated after/.test(routedRef.current?.reason ?? ""),
          });
          push({ kind: "model", id: idRef.current++, model: line.model, provider: line.provider, costText: line.costText, surprising: line.surprising, reason: line.reason ?? undefined });
        }
        if (!hadError && getAccount(acctId)?.exec === "cli") {
          // Real rate events carry actual utilization when near a limit (e.g.
          // seven_day at 81%) — record them as-is.
          const realRates = cm?.rates ?? [];
          if (realRates.length) recordRateLimits(acctId, realRates);
          // Seed a status-only "ok" ONLY for a standard window we have NEVER
          // recorded, so both rows appear immediately on a fresh account. Never
          // overwrite a real utilization snapshot with a synthetic "ok" — a stale
          // real number beats a fake one (the usage probe refreshes it). This is
          // the v0.2.16 regression fix: the old code clobbered the 81% bar.
          const existing = new Set((accountUsage(acctId)?.rates ?? []).map((r) => r.type));
          const reported = new Set(realRates.map((r) => r.type));
          const toSeed = (["five_hour", "seven_day"] as const)
            .filter((t) => !reported.has(t) && !existing.has(t))
            .map((t) => ({ type: t, status: "ok" as const }));
          if (toSeed.length) recordRateLimits(acctId, toSeed);
        }
        bumpUsage(); // a turn just changed spend/limits → let the memoized strip re-read
        // Auto-compact: once the history approaches the budget, summarize old
        // turns (cheap delegated model) so the next turns stay bounded without
        // losing the gist. Best-effort and skipped on interrupt.
        if (!ac.signal.aborted) {
          try {
            // Trigger off the window of the model that ANSWERED (its window is what
            // overflows), not the summarizer's — a 1M summarizer never triggers a
            // 200k haiku turn; a 128k summarizer over-compacts a 1M model.
            const answeringWindow = activeCliRef.current
              ? (activeCliRef.current.binary?.includes("codex") ? (findModel(activeCliModelRef.current ?? "")?.contextWindow ?? 272_000) : 200_000)
              : (findModel(modelId)?.contextWindow ?? 200_000);
            // Budget on the FULL context the next turn will send: history
            // (tokenized with the answering model, not the summarizer) plus the
            // non-history overhead buildContext reported (system + memory +
            // repomap + retrieval). History alone under-counted by 10-20k, so
            // compaction fired at the wrong point relative to the real window.
            // The threshold lives in shouldAutoCompact (compact.ts) — still
            // conservative: the builder's per-turn elision keeps normal sessions
            // bounded; compaction is the deeper safety net.
            const historyTokens = estimateHistoryTokens(msgRef.current, modelId);
            if (shouldAutoCompact(historyTokens, ctxOverheadRef.current, answeringWindow)) {
              setVerb("Compacting context");
              const msg = await compactNow(4, ac.signal);
              // Only narrate when compaction actually changed something — the old
              // "nothing old enough" notice repeated after every turn once the
              // trigger latched, nagging without acting.
              if (!msg.includes("nothing to compact")) notice(msg);
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
        fellOverFromRef.current = null; // per-turn failover signal consumed; reset for the next turn
        flushText(); // commit any buffered text on interrupt (no done/error fired)
        flushToolStreams();
        abortRef.current = null;
        setBusy(false);
        persist();
        // Snapshot this turn's file changes onto the undo stack (/undo, /diff).
        // The whole-tree checkpoint (when one was taken) rides along so /undo can
        // restore shell-side deletes/renames the per-file snapshots can't see.
        const checkpoint = turnCheckpointRef.current ?? undefined;
        turnCheckpointRef.current = null;
        if (turnChanges.length || checkpoint) {
          undoStackRef.current.push({ changes: turnChanges, at: Date.now(), checkpoint });
          try { gitOps.pruneTurnCheckpoints(8); } catch { /* best-effort */ }
        }
        const interrupted = interruptedRef.current;
        if (interrupted) {
          notice("interrupted");
          interruptedRef.current = false;
        }
        void emitHook("turn.end", { changedFiles: [...changedFiles], hadError }).catch(() => {});
        // Pause the type-ahead drain after an ERROR so queued prompts don't
        // auto-fire into a still-broken state; a successful turn re-enables it
        // (L-C). A user interrupt is different: esc is often pressed precisely
        // to get to the queued prompt sooner, so the queue keeps draining.
        lastTurnFailedRef.current = hadError && !interrupted;
        // A brief post-turn beat: confetti on a clean finish, crying on an error.
        // The working line lingers ~1.5s (it unmounts the instant busy goes false
        // otherwise, so these states would never render). Skip on a user interrupt.
        if (!interrupted) try {
          setMascotState(hadError ? "error" : "celebrate");
          // Collapse this turn's live trace into durable facts, then summarize from
          // the FINAL state (a check that failed then passed on retry is not a
          // failure). turnStartId marks where this turn's items begin.
          const prevItems = itemsRef.current;
          const cut = prevItems.findIndex((i) => i.id >= turnStartId);
          const collapsed = cut < 0 ? prevItems.slice() : [...prevItems.slice(0, cut), ...collapseTurn(prevItems.slice(cut), () => idRef.current++)];
          const turnItems = cut < 0 ? [] : collapsed.slice(cut);
          const checkItems = turnItems.filter((i): i is Extract<Item, { kind: "verification" }> => i.kind === "verification");
          const changed = uniq([...changedFiles]);
          const doneChecks = checkItems.map((c) => c.intent ?? c.command);
          const failed = checkItems.filter((c) => !c.ok).map((c) => `${c.intent ?? c.command}: ${c.summary}`).slice(0, 4);
          // Honest "done with proof": on a successful edited turn, state which tier was
          // cleared (tests green > types/build > nothing verified) so the agent never
          // implies "done" when nothing was actually checked.
          const tier = changed.length && !failed.length ? provenTier(checkItems.filter((c) => c.ok).map((c) => c.intent ?? c.command)) : undefined;
          if (changed.length) lastChangedFilesRef.current = changed;
          // Flywheel: every edited turn's VERIFY outcome becomes a measured
          // per-repo prior for (kind, model) — the ground truth that lets the
          // router stop guessing in this repo (priors.ts).
          const ranModel = sessionRef.current.turns[sessionRef.current.turns.length - 1]?.model;
          if (changed.length && ranModel && ranModel !== "unknown") {
            const outcomeKind = routedKindRef.current?.kind ?? "code";
            const outcome = failed.length ? "failed" : tier && tier !== "none" ? "passed" : "unverified";
            try { recordTurnOutcome({ kind: outcomeKind, modelId: ranModel, outcome }); } catch { /* never break settle */ }
            lastOutcomeKeyRef.current = { kind: outcomeKind, modelId: ranModel };
          }
          // Once per session, after a clean code-changing turn in a project whose
          // checks can't prove behavior (no test command at all, or only
          // build/typecheck): offer to capture current behavior with a
          // characterization test. Accepting (/verify test) is what makes the
          // offer self-extinguishing — the model adds a real test script.
          const offerCharTest = !interrupted && shouldOfferCharTest({
            mode: verifyRef.current,
            hadError,
            changedFiles: changed,
            commands: (() => { try { return detectVerificationCommands(process.cwd(), changed); } catch { return []; } })(),
            alreadyOffered: charTestOfferedRef.current,
            optedOut: loadPrefs().offerTests === false,
          });
          // Green with edits → forward move (commit), never a retry of something
          // that already passed. Retry only when a check actually ended red.
          // When the offer fires, the honest next step is the offer itself —
          // the old "run tests" ghost was unactionable with no test runner.
          const next = failed.length ? nextStepFor(failed, changed) : offerCharTest ? "/verify test" : changed.length && !doneChecks.length ? "run tests" : changed.length ? "commit changes" : "/context";
          // A no-op turn (no edits, no checks) gets no summary at all.
          const summaryItem: Item | null = (changed.length || doneChecks.length) ? { kind: "summary", id: idRef.current++, changed, checks: doneChecks, failures: failed, next, tier } : null;
          const offerItem: Item | null = offerCharTest
            ? { kind: "preference", id: idRef.current++, text: "no test command in this project — capture the changed code's current behavior with a characterization test?", acceptCommand: "/verify test" }
            : null;
          if (offerCharTest) charTestOfferedRef.current = true;
          setItems([...collapsed, ...(summaryItem ? [summaryItem] : []), ...(offerItem ? [offerItem] : [])]);
          // Time awareness after every prompt: how long the turn took, plus the
          // prompt-cache hit when the provider served part of the input from cache.
          const elapsed = formatDuration(Date.now() - turnStart);
          const cacheRead = turnUsage.cachedInputTokens ?? 0;
          const totalInput = turnUsage.inputTokens + cacheRead + (turnUsage.cacheCreationInputTokens ?? 0);
          const cachePct = totalInput > 0 && cacheRead > 0 ? Math.round((cacheRead / totalInput) * 100) : 0;
          notice(cachePct > 0 ? `took ${elapsed} · ${cachePct}% of input from cache` : `took ${elapsed}`);
          setSuggestion(next);
          setLinger(true);
          if (lingerRef.current) clearTimeout(lingerRef.current);
          lingerRef.current = setTimeout(() => setLinger(false), 1500);
          // Auto-iterate to green: if checks failed on a turn that edited files,
          // feed the failure back and re-run, bounded by MAX_AUTOFIX_ATTEMPTS.
          // `/verify off` disables this (verifyRef === "off").
          if (shouldAutoFix({ mode: verifyRef.current, attempt, failures: failed, changedFiles: changed })) {
            notice(`checks failed — fixing (attempt ${attempt + 1}/${MAX_AUTOFIX_ATTEMPTS})`);
            const fixPrompt = buildFixPrompt(failed);
            setTimeout(() => void runTurnRef.current?.(fixPrompt, attempt + 1), 0);
          } else if (verifyRef.current === "auto" && attempt >= MAX_AUTOFIX_ATTEMPTS && failed.length) {
            notice(`still failing after ${MAX_AUTOFIX_ATTEMPTS} fix attempts — over to you`);
          }
          // Nudge the user back for long turns (likely stepped away): bell + notify.
          if (Date.now() - turnStart > 8000 && notifyRef.current) {
            bell();
            notify("gearbox", hadError ? "turn finished with an error" : "turn finished");
          }
        } catch { /* a post-turn render/summary throw must never reject runTurn → unhandled rejection that could wedge the app (L-D) */ }
      }
    },
    [runner, defaultRunner, persist],
  );
  // Stable handle so the auto-fix path can re-enter runTurn without it being a dep.
  const runTurnRef = useRef(runTurn);
  runTurnRef.current = runTurn;
  // Clear the post-turn linger timer on unmount so it can't fire setLinger after
  // the app is gone (L-H).
  useEffect(() => () => { if (lingerRef.current) clearTimeout(lingerRef.current); }, []);

  // Generate short git text (commit message / PR title+body) via the routing
  // seam — cheap "summarize" pick, no tools, silent (nothing streams into the
  // transcript). Returns null when no in-loop model can serve (subscription-only
  // setups) so callers fall back to a heuristic the user can edit.
  const generateGitText = useCallback(async (system: string, prompt: string): Promise<string | null> => {
    try {
      // Honor the ACTIVE selector: a pinned model means the user chose where
      // their money goes — titles and commit messages must not quietly route
      // to a different paid provider (they were billing Anthropic while the
      // user had pinned DeepSeek). Auto-routing keeps picking the cheapest.
      const choice = selectorRef.current.select({ prompt, kind: "summarize" });
      if (choice.backend?.kind === "cli") return null;
      const acct = (choice.backend?.kind === "in-loop" && choice.backend.account) || defaultAccount(choice.model.provider);
      const creds = acct ? await resolveCreds(acct) : undefined;
      const r = await runCompletion({ model: choice.model, system, prompt, onEvent: () => {}, creds, maxRetries: onlineRef.current ? 2 : 0 });
      // Spend truth: this runs outside a turn, so it records its own event.
      recordSpend({
        accountId: acct?.id ?? `env:${choice.model.provider}`,
        model: choice.model.id, source: "aux",
        inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens,
        ...resolveTurnCost({ modelId: choice.model.id, isSub: false, usage: r.usage }),
        at: Date.now(),
      });
      const out = (r.text ?? "").trim().replace(/^```[\w-]*\n?|\n?```$/g, "").trim();
      return out || null;
    } catch {
      return null;
    }
  }, []);

  // The dispatcher itself lives in command-handler.ts (extracted so per-session
  // command handling doesn't live in one component closure — the foundation for
  // multi-session tabs). The ctx is built fresh per invocation from refs and
  // the current render's values, so there is no staleness risk.
  const handleCommand = useCallback(
    (text: string) => {
      const ctx: CommandCtx = {
        // refs (stable objects)
        abortRef, accountStatusCacheRef, activeCliModelRef, activeCliRef, askModeRef, atBottomRef,
        busyRef, capsRef, charTestOfferedRef, cliSessionRef, curAsstRef, effortRef, ghostSkinRef,
        gitDraftRef, gitRegenRef, idRef, itemsRef, lastChangedFilesRef, lastOutcomeKeyRef,
        lastPromptRef, modeRef, msgRef, notifyRef, panelRef, panelSessionsRef, resumeListRef,
        routedKindRef, routedRef, runTurnRef, selectorRef, sessionBaseRef, sessionRef, undoStackRef, verifyRef, vimRef,
        // state setters
        setActiveCli, setActiveCliModelId, setBusy, setEffort, setGhostSkin, setItems, setLastInput,
        setLastPick, setMascotState, setPanel, setSelector, setStatusPinned, setSuggestion,
        setThemeEpochState, setTokens, setVerb, setVim, setYoloState,
        // helper callbacks
        applyEffortClamp, buildAccountView, buildPanelModelRows, cliModelChoices, cliModelLabel,
        cliSupportsModel, compactNow, echo, effortTarget, exit, findAccountRef, flashMood,
        flashStatus, formatCliModelList, generateGitText, handleAddResult, leaveSubscription, loadInto, notice,
        openInfoPanel, persist, probeAccountUsage, push, pushAccounts, pushPhase, refreshCliStatuses,
        resolveCliModel, resumableSessions, runInteractive, runTurn, sessionWhen, toast, togglePlan,
        updatePhase,
        // render-time values
        activeCli, fullscreen, model, onboardingState, selectorKind, statusPinned, tabs,
      };
      dispatchCommand(ctx, text);
    },
    [exit, runTurn, onboardingState, tabs],
  );
  handleCommandRef.current = handleCommand; // the raw mouse handler dispatches through this

  const submit = useCallback(
    (value: string) => {
      let text = value.trim();
      // Expand any collapsed-paste chips back to their real text before sending.
      // Delete ONLY the chips used in THIS submit — clearing the whole store dropped
      // chips still pending in a queued/edited prompt (I-H).
      if (pasteStoreRef.current.size) {
        for (const [ph, full] of pasteStoreRef.current) if (text.includes(ph)) { text = text.split(ph).join(full); pasteStoreRef.current.delete(ph); }
      }
      setEdit({ value: "", cursor: 0 });
      histIdxRef.current = null;
      if (!text) return;
      const h = historyRef.current;
      if (h[h.length - 1] !== text) h.push(text);
      appendHistory(text); // persist across runs
      // In bash mode every line is a shell command — route it through the `!` path
      // and STAY in bash mode (a sticky shell REPL). `/`-commands still escape. (iii)
      if (bashModeRef.current && !text.startsWith("/") && !text.startsWith("!")) text = "!" + text;
      if (text.startsWith("!")) {
        const cmd = text.slice(1).trim();
        echo(text);
        if (!cmd) {
          notice("run a shell command with !<command> · e.g. !git status");
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
        if (note && appendFact(note)) toast("remembered");
        else notice("usage: #<note to remember>");
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
        // Queue it · sent automatically when the current turn finishes.
        queueRef.current.push(text);
        setQueued([...queueRef.current]);
        notice(`queued (${queueRef.current.length}) · sends when the current turn finishes`);
        return;
      }
      // Auto-detect a question ABOUT Gearbox and answer it from the docs, with a
      // visible affordance so it never silently hijacks a real coding prompt.
      if (looksLikeGearboxQuestion(text)) {
        notice("↳ answering from Gearbox's own docs · rephrase as a task, or /help, to run it as a normal turn");
        askModeRef.current = true;
      }
      void runTurn(text);
    },
    [handleCommand, runTurn, setupRequired, onboardingState],
  );

  // Drain the type-ahead queue when a turn finishes — but NOT after an error
  // (L-C): auto-firing the next queued prompt into a broken state just error-loops
  // the whole queue. A user interrupt does NOT hold the queue (esc is often
  // pressed to get to the queued prompt sooner). The next successful turn clears
  // the error flag and resumes draining.
  useEffect(() => {
    if (busy || queueRef.current.length === 0 || lastTurnFailedRef.current) return;
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
    notice("rewound the last turn · edit and resend");
  };

  // Commit an accumulated markerless paste as ONE unit (chip if large, else insert).
  const commitCoalescedPaste = () => {
    if (pasteCoalesceTimerRef.current) { clearTimeout(pasteCoalesceTimerRef.current); pasteCoalesceTimerRef.current = null; }
    const raw = pasteCoalesceRef.current;
    pasteCoalesceRef.current = null;
    if (raw == null) return;
    const clean = sanitizeInputText(raw);
    if (!clean) return;
    const e = editRef.current;
    if (!clean.includes("\n") && clean.length <= 400 && attachPastedPath(clean, e)) return; // a single file path → drag-drop
    const lines = clean.split("\n").length;
    if (clean.length > 400 || lines > 4) {
      const id = ++pasteIdRef.current;
      const ph = `[Pasted #${id}: ${lines} line${lines === 1 ? "" : "s"} · ${clean.length.toLocaleString()} chars]`;
      pasteStoreRef.current.set(ph, clean);
      setEdit({ value: e.value.slice(0, e.cursor) + ph + e.value.slice(e.cursor), cursor: e.cursor + ph.length });
    } else {
      setEdit({ value: e.value.slice(0, e.cursor) + clean + e.value.slice(e.cursor), cursor: e.cursor + clean.length });
    }
  };

  useInput((input, key) => {
    // Swallow any stray mouse-report bytes so they never land in the composer
    // (the wheel is handled by the raw stdin listener above).
    if (/\[<\d+;\d+;\d+[Mm]/.test(input)) return;
    // Conductor tabs: ⌃T cycles to the next session (the /tab command covers
    // create/close/jump). Only the active tab's useInput runs, so this is safe.
    if (tabs && key.ctrl && input === "t") { tabs.cycle(1); return; }
    // Bracketed-paste assembly: the terminal wraps a paste in \x1b[200~ … \x1b[201~.
    // Buffer from the opener to the closer (possibly across several reads), then
    // collapse the whole blob · big pastes become a [Pasted N lines · M chars] chip
    // instead of flooding the composer or submitting on an embedded newline.
    if (pasteBufRef.current !== null || input.includes("\x1b[200~")) {
      pasteBufRef.current = (pasteBufRef.current ?? "") + input;
      if (!pasteBufRef.current.includes("\x1b[201~")) return; // keep buffering
      const clean = sanitizeInputText(pasteBufRef.current.replace(/\x1b\[20[01]~/g, ""));
      pasteBufRef.current = null;
      const e = editRef.current;
      // An EMPTY paste with an image on the clipboard = cmd-V of a screenshot. The
      // terminal can't paste binary, so grab the image off the OS clipboard and
      // attach it as a chip, the same as a dragged-in file path.
      if (clean.trim() === "") {
        const imgPath = clipboardImageToFile();
        if (imgPath) {
          const marker = imageMarkerFor(imgPath);
          setEdit({ value: e.value.slice(0, e.cursor) + marker + " " + e.value.slice(e.cursor), cursor: e.cursor + marker.length + 1 });
          flashStatus("attached image from clipboard");
        }
        return;
      }
      // Some terminals paste an image/file as its temp PATH (wrapped in the same
      // bracketed markers). Treat a single existing path like a drag-drop: image →
      // chip, other file → @mention.
      if (attachPastedPath(clean, e)) return;
      const lines = clean.split("\n").length;
      if (clean.length > 400 || lines > 4) {
        const id = ++pasteIdRef.current;
        const ph = `[Pasted #${id}: ${lines} line${lines === 1 ? "" : "s"} · ${clean.length.toLocaleString()} chars]`;
        pasteStoreRef.current.set(ph, clean);
        setEdit({ value: e.value.slice(0, e.cursor) + ph + e.value.slice(e.cursor), cursor: e.cursor + ph.length });
      } else {
        setEdit({ value: e.value.slice(0, e.cursor) + clean + e.value.slice(e.cursor), cursor: e.cursor + clean.length });
      }
      return;
    }
    // A pending permission request captures input until it's answered.
    if (permRef.current) {
      if (input === "1") resolvePerm("once");
      else if (input === "2") resolvePerm("always");
      else if (input === "a" || input === "A") resolvePerm("all");
      else if (input === "3" || key.escape) resolvePerm("deny");
      return;
    }
    // An open status-bar click picker captures navigation keys: ↑/↓ move, Enter
    // confirms (submits /model X or /effort Y), Esc or any other key dismisses.
    if (quickPickerRef.current) {
      const rows = quickPickerRows(quickPickerRef.current);
      if (key.upArrow || key.downArrow) {
        if (rows.length) {
          const delta = key.upArrow ? -1 : 1;
          setQuickPickerIndex((quickPickerIndexRef.current + delta + rows.length) % rows.length);
        }
        return;
      }
      if (key.return) {
        const row = rows[Math.min(quickPickerIndexRef.current, rows.length - 1)];
        setQuickPicker(null);
        if (row) submit(row.value);
        return;
      }
      setQuickPicker(null); // Esc or any other key dismisses the overlay
      return;
    }
    // ⌃C · interrupt a turn; else clear the composer; else "press again to quit".
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
        persist(); // ⌃C-⌃C quit: save the conversation first (I-D)
        exit();
        return;
      }
      ctrlCRef.current = now;
      notice("press ⌃C again to quit");
      return;
    }
    // Dismissable command panel: while open it owns the keyboard. Esc closes it
    // (taking precedence over the composer's esc-interrupt); navigation scrolls a
    // static dump or moves the selection in an interactive list; ⏎ acts.
    if (panelRef.current) {
      const p = panelRef.current;
      if (key.escape) {
        // Wizard field phase: Esc steps back one field (or to pick) rather than closing.
        if (p.kind === "wizard" && p.wizardPhase.phase === "field") {
          const wSpec = p.wizardPhase.fieldIndex > 0 ? specFor(p.wizardPhase.specId) : undefined;
          setPanel(wizardBack(p, wSpec));
          return;
        }
        // Account-detail: esc steps back through sub-phases; browse → close.
        if (p.kind === "account-detail") {
          if (p.submitting) return; // block esc during in-flight operations
          if (p.detailPhase.phase !== "browse") { setPanel(detailBack(p)); return; }
        }
        if (p.kind === "sessions" && p.rename) { setPanel({ ...p, rename: undefined }); return; }
        if (p.kind === "sessions" && p.confirmDelete) { setPanel({ ...p, confirmDelete: undefined }); return; }
        if (p.kind === "git-confirm" && p.submitting) return; // a commit/PR is mid-flight
        if (p.kind === "themes") {
          // The gallery previews live — esc means "never mind", restore the original.
          setTheme(p.original);
          setThemeEpochState((e) => e + 1);
        }
        if (p.kind === "ghosts") setGhostSkin(p.original); // revert the previewed look
        setPanel(null); return;
      }
      if (p.kind === "static") {
        if (input === "q") { setPanel(null); return; }
        const max = panelMaxScrollRef.current;
        const page = Math.max(1, panelBodyHeight(viewportHeightRef.current) - 1);
        if (key.upArrow) setPanel({ ...p, scroll: clampScroll(p.scroll - 1, max) });
        else if (key.downArrow) setPanel({ ...p, scroll: clampScroll(p.scroll + 1, max) });
        else if (key.pageUp) setPanel({ ...p, scroll: clampScroll(p.scroll - page, max) });
        else if (key.pageDown) setPanel({ ...p, scroll: clampScroll(p.scroll + page, max) });
        return;
      }
      if (p.kind === "diff") {
        if (input === "q") { setPanel(null); return; }
        // Mirror Panel.tsx's split: file list ≤1/3 of the body, diff pane below.
        const bodyH = panelBodyHeight(viewportHeightRef.current);
        const listH = Math.max(1, Math.min(p.files.length || 1, Math.floor(bodyH / 3)));
        const diffH = Math.max(1, bodyH - listH - 1);
        const loadSel = (next: ReturnType<typeof diffMove>) =>
          next.files.length && next.diff === null
            ? diffSetText(next, gitOps.fileDiffSince(next.baseline, next.files[next.index]!.path))
            : next;
        if (key.upArrow) setPanel(loadSel(diffMove(p, -1)));
        else if (key.downArrow) setPanel(loadSel(diffMove(p, 1)));
        else if (key.pageUp) setPanel(diffScroll(p, -Math.max(1, diffH - 1), diffH));
        else if (key.pageDown) setPanel(diffScroll(p, Math.max(1, diffH - 1), diffH));
        return;
      }
      if (p.kind === "accounts") {
        const slugs = panelAccountSlugsRef.current;
        const n = slugs.length;
        if (key.upArrow) setPanel({ ...p, index: clampIndex(p.index - 1, n) });
        else if (key.downArrow) setPanel({ ...p, index: clampIndex(p.index + 1, n) });
        else if (key.return) {
          const slug = slugs[clampIndex(p.index, n)];
          if (slug === "__add__") {
            setPanel(wizardOpen("add an account"));
          } else {
            setPanel(null);
            if (slug) handleCommand(`/account ${slug}`);
          }
        } else if (key.rightArrow) {
          const slug = slugs[clampIndex(p.index, n)];
          if (slug && slug !== "__add__") {
            const acc = listAccounts().find((a) => (a.slug ?? a.id) === slug);
            if (acc && (acc.provider === "azure" || acc.provider === "azure-foundry")) {
              setPanel(detailOpen(acc.id, accountName(acc)));
              const capturedAcc = acc;
              const seq = ++detailLoadSeqRef.current;
              void listDeploymentDetails(capturedAcc).then((r) =>
                setPanel((prev) =>
                  prev?.kind === "account-detail" && prev.accountId === capturedAcc.id && seq === detailLoadSeqRef.current
                    ? (r.ok ? detailSetDeployments(prev as AccountDetailPanel, r.deployments) : detailSetError(prev as AccountDetailPanel, r.note ?? "load failed"))
                    : prev,
                ),
              );
              void listAvailableModels(capturedAcc).then((r) =>
                setPanel((prev) =>
                  prev?.kind === "account-detail" && prev.accountId === capturedAcc.id && seq === detailLoadSeqRef.current
                    ? (r.ok
                        ? detailSetAvailableModels(prev as AccountDetailPanel, r.models)
                        : detailSetModelsError(prev as AccountDetailPanel, r.note ?? "couldn't load deployable models"))
                    : prev,
                ),
              );
              // Cheap no-network probe: warn up front when deploy/delete would
              // fail for lack of an ARM sign-in, instead of at the end of the flow.
              void armAuthReady().then((ready) =>
                setPanel((prev) =>
                  prev?.kind === "account-detail" && prev.accountId === capturedAcc.id && seq === detailLoadSeqRef.current
                    ? detailSetArmReady(prev as AccountDetailPanel, ready)
                    : prev,
                ),
              );
            } else if (acc) {
              notice(`account details not available for ${acc.provider} yet`);
            }
          }
        }
        return;
      }
      if (p.kind === "sessions") {
        const sess = panelSessionsRef.current;
        const n = sess.length;
        const refresh = (index: number) => {
          const next = resumableSessions().sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false) || b.updatedAt - a.updatedAt);
          panelSessionsRef.current = next;
          resumeListRef.current = next;
          setPanel({ kind: "sessions", title: p.title, index: clampIndex(index, next.length) });
        };
        // Rename phase: the title is a live edit field; ⏎ saves, esc cancels.
        if (p.rename) {
          if (key.escape) { setPanel({ ...p, rename: undefined }); return; }
          const action = applyKey(p.rename.fieldEdit, input, key);
          if (action.type === "edit") { setPanel({ ...p, rename: { ...p.rename, fieldEdit: action.state } }); return; }
          if (action.type === "submit") {
            const title = p.rename.fieldEdit.value.trim();
            if (title) updateSessionMeta(p.rename.id, { title });
            refresh(p.index);
            if (title) toast(`renamed · ${title.slice(0, 48)}`);
          }
          return;
        }
        const cur = sess[clampIndex(p.index, n)];
        if (key.upArrow) { setPanel({ ...p, index: clampIndex(p.index - 1, n), confirmDelete: undefined }); return; }
        if (key.downArrow) { setPanel({ ...p, index: clampIndex(p.index + 1, n), confirmDelete: undefined }); return; }
        if (key.return) { setPanel(null); if (cur) loadInto(cur); return; }
        if (input === "p" && cur) {
          updateSessionMeta(cur.id, { pinned: !cur.pinned });
          refresh(p.index);
          toast(cur.pinned ? "unpinned" : "pinned · stays at the top of /resume", "info");
          return;
        }
        if (input === "r" && cur) {
          setPanel({ ...p, confirmDelete: undefined, rename: { id: cur.id, fieldEdit: { value: cur.title ?? "", cursor: (cur.title ?? "").length } } });
          return;
        }
        if (input === "d" && cur) {
          // Deleting a conversation is destructive: d arms, d again fires.
          if (p.confirmDelete === cur.id) {
            deleteSession(cur.id);
            refresh(p.index);
            toast("session deleted", "info");
          } else {
            setPanel({ ...p, confirmDelete: cur.id });
          }
          return;
        }
        return;
      }
      if (p.kind === "account-detail") {
        if (p.submitting) return; // all keys blocked while in-flight
        if (key.leftArrow) {
          if (p.detailPhase.phase !== "browse") { setPanel(detailBack(p)); return; }
          // browse → back to accounts list
          setPanel({ kind: "accounts", title: "accounts · ⏎ to switch", index: 0 });
          return;
        }
        const ph = p.detailPhase;
        if (ph.phase === "browse") {
          if (key.upArrow) { setPanel(detailMoveIndex(p, -1, p.deployments?.length ?? 0)); return; }
          if (key.downArrow) { setPanel(detailMoveIndex(p, 1, p.deployments?.length ?? 0)); return; }
          if (input === "d" && !key.ctrl && !key.meta) {
            if (p.availableModels !== null) { setPanel(detailStartDeploy(p)); }
            else if (p.modelsError) { notice(`couldn't load deployable models: ${p.modelsError} · press r to retry`); }
            else { notice("models still loading — wait a moment"); }
            return;
          }
          if ((key.backspace || key.delete) && p.deployments && p.deployments.length > 0) {
            const dep = p.deployments[clampIndex(p.index, p.deployments.length)];
            if (dep) { setPanel(detailStartDelete(p, dep.id)); }
            return;
          }
          if (input === "r" && !key.ctrl && !key.meta) {
            // Block only a genuinely in-flight load. A FAILED initial load
            // leaves deployments null WITH loadError set — that's exactly when
            // r must work, or the error state is a dead end.
            if ((p.deployments === null && !p.loadError) || p.refreshing) return;
            const acc = listAccounts().find((a) => a.id === p.accountId);
            if (acc) {
              // Keep the stale list visible under a "refreshing…" note instead of
              // blanking it (the old inline `deployments: null` spread did that).
              setPanel(detailStartRefresh(p));
              const capturedAcc = acc;
              const seq = ++detailLoadSeqRef.current;
              void listDeploymentDetails(capturedAcc).then((r) =>
                setPanel((prev) =>
                  prev?.kind === "account-detail" && prev.accountId === capturedAcc.id && seq === detailLoadSeqRef.current
                    ? (r.ok ? detailSetDeployments(prev as AccountDetailPanel, r.deployments) : detailSetError(prev as AccountDetailPanel, r.note ?? "load failed"))
                    : prev,
                ),
              );
              // A failed (or never-finished) models load retries here too — the
              // only recovery path the panel has for deploy being disabled.
              if (p.availableModels === null || p.modelsError) {
                void listAvailableModels(capturedAcc).then((r) =>
                  setPanel((prev) =>
                    prev?.kind === "account-detail" && prev.accountId === capturedAcc.id && seq === detailLoadSeqRef.current
                      ? (r.ok
                          ? detailSetAvailableModels(prev as AccountDetailPanel, r.models)
                          : detailSetModelsError(prev as AccountDetailPanel, r.note ?? "couldn't load deployable models"))
                      : prev,
                  ),
                );
              }
            }
            return;
          }
        } else if (ph.phase === "deploy-pick") {
          const q = ph.filter.trim().toLowerCase();
          const filteredModels = q ? (p.availableModels ?? []).filter((m) => m.toLowerCase().includes(q)) : (p.availableModels ?? []);
          if (key.upArrow) { setPanel(detailDeployMove(p, -1, filteredModels.length)); return; }
          if (key.downArrow) { setPanel(detailDeployMove(p, 1, filteredModels.length)); return; }
          if (key.return) {
            const m = filteredModels[clampIndex(ph.index, filteredModels.length)];
            if (m) setPanel(detailPickCapacity(p, m));
            return;
          }
          if (key.backspace || key.delete) { setPanel(detailDeployBackspace(p)); return; }
          if (input && !key.ctrl && !key.meta && !key.tab && input.length === 1 && input >= " ") { setPanel(detailDeployFilter(p, input)); return; }
          return;
        } else if (ph.phase === "capacity-type") {
          if (key.upArrow) { setPanel(detailCapacityMove(p, -1)); return; }
          if (key.downArrow) { setPanel(detailCapacityMove(p, 1)); return; }
          if (key.return) {
            const types = ["Standard", "GlobalStandard", "ProvisionedManaged"];
            const t = types[clampIndex(ph.index, types.length)];
            if (t) setPanel(detailConfirmCapacity(p, t));
            return;
          }
          return;
        } else if (ph.phase === "deploy-name") {
          const action = applyKey(ph.fieldEdit, input, key);
          if (action.type === "edit") { setPanel(detailNameEdit(p, action.state)); return; }
          if (action.type === "submit") {
            const next = detailNameAdvance(p);
            if (detailIsNameComplete(next)) {
              const acc = listAccounts().find((a) => a.id === p.accountId);
              if (acc) {
                const deployName = ph.fieldEdit.value.trim();
                const selectedModel = ph.selectedModel;
                const capacityType = ph.capacityType;
                setPanel(detailSetSubmitting(next, true));
                void createDeployment(acc, deployName, selectedModel, capacityType).then((r) => {
                  if (!r.ok) {
                    notice(`deploy failed: ${r.note ?? "unknown error"}`);
                    setPanel((prev) =>
                      prev?.kind === "account-detail" && prev.accountId === acc.id
                        ? detailSetSubmitting(prev as AccountDetailPanel, false)
                        : prev,
                    );
                    return;
                  }
                  setPanel((prev) =>
                    prev?.kind === "account-detail" && prev.accountId === acc.id
                      ? { ...detailSetSubmitting(prev as AccountDetailPanel, false), detailPhase: { phase: "browse" as const } }
                      : prev,
                  );
                  const seq = ++detailLoadSeqRef.current;
                  void listDeploymentDetails(acc).then((lr) =>
                    setPanel((p2) =>
                      p2?.kind === "account-detail" && p2.accountId === acc.id && seq === detailLoadSeqRef.current
                        ? (lr.ok
                            ? detailSetDeployments(p2 as AccountDetailPanel, lr.deployments)
                            : detailSetError(p2 as AccountDetailPanel, lr.note ?? "reload failed — press r to refresh"))
                        : p2,
                    ),
                  );
                });
              } else {
                setPanel(next);
              }
            } else {
              setPanel(next); // validation error; stays on field
            }
            return;
          }
          return;
        } else if (ph.phase === "confirm-delete") {
          if (key.return) {
            const acc = listAccounts().find((a) => a.id === p.accountId);
            const deploymentId = ph.deploymentId;
            if (acc) {
              const browsePanel = detailOptimisticRemove(
                detailSetSubmitting({ ...p, detailPhase: { phase: "browse" } }, true),
                deploymentId,
              );
              setPanel(browsePanel);
              void deleteDeployment(acc, deploymentId).then((r) => {
                if (!r.ok) {
                  notice(`delete failed: ${r.note ?? "unknown error"}`);
                  const seq = ++detailLoadSeqRef.current;
                  void listDeploymentDetails(acc).then((lr) =>
                    setPanel((p2) =>
                      p2?.kind === "account-detail" && p2.accountId === acc.id && seq === detailLoadSeqRef.current
                        ? (lr.ok ? detailSetDeployments(p2 as AccountDetailPanel, lr.deployments) : p2)
                        : p2,
                    ),
                  );
                }
                setPanel((prev) =>
                  prev?.kind === "account-detail" && prev.accountId === acc.id
                    ? detailSetSubmitting(prev as AccountDetailPanel, false)
                    : prev,
                );
              });
            }
            return;
          }
          if (input === "n" && !key.ctrl && !key.meta) { setPanel(detailBack(p)); return; }
          return;
        }
        return;
      }
      // themes: ↑↓ previews LIVE on the whole UI, ⏎ keeps, esc reverts (esc branch).
      if (p.kind === "themes") {
        const apply = (idx: number) => {
          const next = clampIndex(idx, THEMES.length);
          setTheme(THEMES[next]!.name);
          setThemeEpochState((e) => e + 1);
          setPanel({ ...p, index: next });
        };
        if (key.upArrow) { apply(p.index - 1); return; }
        if (key.downArrow) { apply(p.index + 1); return; }
        if (key.return) {
          const picked = THEMES[clampIndex(p.index, THEMES.length)]!;
          setTheme(picked.name);
          updatePrefs({ theme: picked.name });
          setThemeEpochState((e) => e + 1);
          setPanel(null);
          toast(`theme → ${picked.name}`);
          return;
        }
        return;
      }
      // ghosts: ↑↓ previews LIVE on the splash, ⏎ keeps, esc reverts (esc branch).
      if (p.kind === "ghosts") {
        const apply = (idx: number) => {
          const next = clampIndex(idx, GHOST_LOOKS.length);
          setGhostSkin(GHOST_LOOKS[next]!.value);
          setPanel({ ...p, index: next });
        };
        if (key.upArrow) { apply(p.index - 1); return; }
        if (key.downArrow) { apply(p.index + 1); return; }
        if (key.return) {
          const picked = GHOST_LOOKS[clampIndex(p.index, GHOST_LOOKS.length)]!;
          setGhostSkin(picked.value);
          updatePrefs({ ghost: picked.value });
          setPanel(null);
          toast(`Boo → ${picked.label}`);
          return;
        }
        return;
      }
      // git-confirm: review/edit the generated subject, ⏎ executes, ⌃R regenerates.
      if (p.kind === "git-confirm") {
        if (p.submitting) return;
        if (key.ctrl && input === "r") {
          const regen = gitRegenRef.current;
          if (!regen) return;
          setPanel(gitConfirmSetSubmitting(p, true));
          void generateGitText(regen.system, regen.prompt).then((gen) => {
            setPanel((prev) => {
              if (prev?.kind !== "git-confirm") return prev;
              if (!gen) return gitConfirmError(prev as GitConfirmPanel, "couldn't regenerate — edit the text instead");
              const { subject, body: genBody } = splitSubject(gen);
              return gitConfirmOpen({ mode: regen.mode, subject, body: genBody, files: regen.files, stat: regen.stat });
            });
          });
          return;
        }
        const action = applyKey(p.subject, input, key);
        if (action.type === "edit") { setPanel(gitConfirmEdit(p, action.state)); return; }
        if (action.type === "submit") {
          if (!gitConfirmReady(p)) { setPanel(gitConfirmError(p, "the subject can't be empty")); return; }
          setPanel(gitConfirmSetSubmitting(p, true));
          if (p.mode === "commit") {
            setTimeout(() => {
              const r = gitOps.commit(gitConfirmMessage(p));
              if (!r.ok) { setPanel((prev) => (prev?.kind === "git-confirm" ? gitConfirmError(prev as GitConfirmPanel, r.err || r.out) : prev)); return; }
              setPanel(null);
              invalidateGitBranch();
              notice(`✓ committed · ${gitOps.lastCommits(1)[0] ?? ""}`);
            }, 0);
          } else {
            void gitOps.prCreate({ title: p.subject.value.trim(), body: p.body }).then((r) => {
              if (!r.ok) { setPanel((prev) => (prev?.kind === "git-confirm" ? gitConfirmError(prev as GitConfirmPanel, r.output.split("\n").find((l) => l.trim()) ?? "gh pr create failed") : prev)); return; }
              setPanel(null);
              notice(`✓ PR created · ${r.output.split("\n").findLast((l) => /https?:\/\//.test(l)) ?? r.output}`);
            });
          }
          return;
        }
        return;
      }
      // wizard: pick (provider list + type-to-filter) → field (one field at a time via applyKey)
      if (p.kind === "wizard") {
        const ph = p.wizardPhase;
        if (ph.phase === "pick") {
          const specs = filterAddSpecs(ph.filter);
          if (key.upArrow) { setPanel(wizardPickMove(p, -1, specs.length)); return; }
          if (key.downArrow) { setPanel(wizardPickMove(p, 1, specs.length)); return; }
          if (key.return) {
            const s = specs[clampIndex(ph.index, specs.length)];
            if (s) {
              if (s.group === "subscription") {
                setPanel(null);
                handleCommand(`/account add ${s.id.replace("-subscription", "")}`);
              } else if (!s.fields.length) {
                setPanel(null);
                handleCommand(s.paletteCommand);
              } else {
                setPanel(wizardPickConfirm(p, s.id));
              }
            }
            return;
          }
          if (key.backspace || key.delete) { setPanel(wizardPickBackspace(p)); return; }
          if (input && !key.ctrl && !key.meta && !key.tab && input.length === 1 && input >= " ") {
            setPanel(wizardPickFilter(p, input));
            return;
          }
          return;
        }
        // field phase — keys go through applyKey just like the composer
        const wSpec = specFor(ph.specId);
        const action = applyKey(ph.fieldEdit, input, key);
        if (action.type === "edit") {
          setPanel(wizardFieldEdit(p, action.state));
          return;
        }
        if (action.type === "submit") {
          if (!wSpec) { setPanel(null); return; }
          const next = wizardFieldAdvance(p, wSpec);
          if (wizardIsComplete(next, wSpec)) {
            const filledPhase = next.wizardPhase as Extract<typeof next.wizardPhase, { phase: "field" }>;
            setPanel(null);
            void wSpec.build(filledPhase.filled).then((res: AddResult) => {
              if (res.ok && res.account) void handleAddResult(res.account, res.message);
              else notice(buildAddGuidance(wSpec.id, res.message));
            });
          } else {
            setPanel(next);
          }
          return;
        }
        return;
      }
      // models: type-to-filter, ↑↓ select, ⏎ pin
      if (p.kind === "models") {
        const rows = filterModelRows(buildPanelModelRows(), p.filter);
        if (key.upArrow) setPanel({ ...p, index: clampIndex(p.index - 1, rows.length) });
        else if (key.downArrow) setPanel({ ...p, index: clampIndex(p.index + 1, rows.length) });
        else if (key.return) { const r = rows[clampIndex(p.index, rows.length)]; setPanel(null); if (r) handleCommand(`/model ${r.id}`); }
        else if (key.backspace || key.delete) setPanel(backspaceFilter(p));
        else if (input && !key.ctrl && !key.meta && !key.tab && input.length === 1 && input >= " ") setPanel(appendFilter(p, input));
        return;
      }
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
      const cmdMatches = commandNameMatches(draft);
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
    // ⌃O · toggle full diffs / tool output (un-truncate the 16-line cap).
    if (key.ctrl && input === "o") {
      setExpandAll((x) => {
        flashStatus(x ? "collapsed long output" : "expanded full diffs and output");
        return !x;
      });
      return;
    }
    // ⌃V · attach an image from the clipboard. A guaranteed manual path for
    // terminals that don't surface cmd-V of a screenshot to the app at all.
    if (key.ctrl && input === "v") {
      const imgPath = clipboardImageToFile();
      if (imgPath) {
        const e = editRef.current;
        const marker = imageMarkerFor(imgPath);
        setEdit({ value: e.value.slice(0, e.cursor) + marker + " " + e.value.slice(e.cursor), cursor: e.cursor + marker.length + 1 });
        flashStatus("attached image from clipboard");
      } else {
        notice("no image on the clipboard · drag a file in, or paste its path");
      }
      return;
    }
    // ⌃Y · copy the last assistant reply to the clipboard (OSC 52; works over SSH).
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
    // file, turn it into an image chip / @mention so it gets read into the prompt.
    if (!busyRef.current && input.length > 3 && !input.includes("\n")) {
      if (attachPastedPath(input, editRef.current)) return;
    }
    // Markerless paste (tmux/ssh/some emulators, or a stray-marker terminal). A read
    // this big can't be a single keypress — it's a paste chunk — so accumulate it and
    // any rapid follow-up reads within a short quiet window, then commit ONCE. This is
    // what stops a multi-read paste from "splitting up" into several chips and from
    // re-rendering N times (the 3s lag). Typing (a char or an escape seq, which
    // sanitizes to ~nothing) stays under the threshold and flows normally below.
    if (!busyRef.current && (pasteCoalesceRef.current !== null || sanitizeInputText(input).length > 16)) {
      pasteCoalesceRef.current = (pasteCoalesceRef.current ?? "") + input;
      if (pasteCoalesceTimerRef.current) clearTimeout(pasteCoalesceTimerRef.current);
      pasteCoalesceTimerRef.current = setTimeout(commitCoalescedPaste, 30);
      return;
    }
    // `!` on an empty composer enters sticky bash mode (the ! is consumed). esc
    // exits (handled in the interrupt action). (iii)
    if (!bashModeRef.current && input === "!" && editRef.current.value === "" && !busyRef.current && !permRef.current && !panelRef.current) {
      setBashMode(true);
      return;
    }
    const action = applyKey(editRef.current, input, key, vimRef.current === "off" ? undefined : { normal: vimRef.current === "normal" });
    if (busyRef.current) {
      // While a turn runs you can still type — submit queues (drained when the
      // turn ends), edits build the next prompt live, ↑/↓ recall history. esc
      // clears a non-empty composer, else interrupts the turn.
      switch (action.type) {
        case "edit":
          if (suggestion) setSuggestion(null);
          histIdxRef.current = null; // typing detaches from the history cursor (I-E)
          setEdit(action.state);
          break;
        case "submit":
          submit(editRef.current.value);
          break;
        case "history": {
          if (histIdxRef.current === null) liveLineRef.current = editRef.current.value; // stash the live draft before stepping into history
          const r = navHistory(historyRef.current, histIdxRef.current, action.dir, liveLineRef.current);
          histIdxRef.current = r.idx;
          setEdit({ value: r.value, cursor: r.value.length });
          break;
        }
        case "interrupt":
          if (editRef.current.value) {
            setEdit({ value: "", cursor: 0 });
          } else {
            interruptedRef.current = true;
            abortRef.current?.abort();
          }
          break;
      }
      return;
    }
    switch (action.type) {
      case "edit":
        if (suggestion) setSuggestion(null);
        histIdxRef.current = null; // typing detaches from the history cursor (I-E)
        setEdit(action.state);
        break;
      case "submit":
        submit(editRef.current.value);
        break;
      case "history": {
        if (histIdxRef.current === null) liveLineRef.current = editRef.current.value; // stash the live draft before stepping into history
        const r = navHistory(historyRef.current, histIdxRef.current, action.dir, liveLineRef.current);
        histIdxRef.current = r.idx;
        setEdit({ value: r.value, cursor: r.value.length });
        break;
      }
      case "interrupt": {
        // esc exits bash mode first, back to normal input (iii).
        if (bashModeRef.current) { setBashMode(false); setEdit({ value: "", cursor: 0 }); break; }
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
  }, { isActive: isRawModeSupported && active });

  const mention = currentMention(edit.value, edit.cursor);
  const fileMatches = mention ? matchFiles(listProjectFiles(), mention.token) : [];

  const welcome = items.length === 0;
  const pickerRows = commandPickerRows(edit.value);
  const cmdMatches = commandNameMatches(edit.value);
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

  // Fold a delegate_parallel batch into one collapsed row the MOMENT it settles —
  // not at end-of-turn. The group finishes long before the parent turn does (the
  // agent keeps working with the results), so collapsing only at turn-end leaves a
  // finished 5-task ladder sprawled across the screen the whole time. This live
  // fold (idempotent; end-of-turn collapseTurn re-applies harmlessly) keeps the
  // running view detailed and compacts each batch as soon as it's done.
  const displayItems = useMemo(() => collapseDelegateGroups(items), [items]);

  // The transcript as a flat styled-line buffer. The content column is CAPPED
  // (≤92 cols) and centered — a transcript that reads like a document, not a
  // log dump spanning an ultrawide. The margin is baked into the lines (not a
  // Box offset) so mouse-selection column math stays 1:1 with the screen.
  const CONTENT_CAP = Math.max(92, Math.floor((width - 3) * 0.8));
  const lineWidth = Math.max(Math.min(width - 3, CONTENT_CAP), 20);
  const marginCols = Math.max(0, Math.floor((width - 3 - lineWidth) / 2));
  // The shared PAGE column (Broadsheet "one page"): every footer surface sits in
  // the same centered column as the transcript. +1 mirrors the transcript Box's
  // paddingX so the columns align exactly; pageW = lineWidth + the 2-col padding
  // the footer components carry themselves (paddingX={1}).
  const pageLeft = marginCols ? marginCols + 1 : 0;
  const pageW = lineWidth + 2;
  pageWRef.current = pageW;
  pageLeftRef.current = fullscreen ? pageLeft : 0;
  // History recede: while a turn runs or a consent is pending, settled items
  // render in receded ink so the now-row / consent line is the only bright thing.
  const recede = busy || !!perm;
  const padCacheRef = useRef(new WeakMap<Line, Line>()); // centered-margin pad, keyed by raw line ref
  const padCacheKeyRef = useRef(0);
  const lines = useMemo(() => {
    const raw = itemsToLines(displayItems, lineWidth, expandAll, recede);
    if (!marginCols) return raw;
    // Cache the padded line BY RAW-LINE REF: itemsToLines keeps stable refs for
    // unchanged items (its WeakMap), and rebuilding `[pad, ...l]` fresh each pass
    // gave every row a new identity on wide terminals — defeating LineRow's
    // reference memo on every streaming flush. Reset when the margin changes.
    if (padCacheKeyRef.current !== marginCols) {
      padCacheRef.current = new WeakMap();
      padCacheKeyRef.current = marginCols;
    }
    const cache = padCacheRef.current;
    const pad = { text: " ".repeat(marginCols) };
    return raw.map((l) => {
      if (!l.length) return l;
      let p = cache.get(l);
      if (!p) {
        p = [pad, ...l];
        cache.set(l, p);
      }
      return p;
    });
  }, [displayItems, lineWidth, marginCols, expandAll, recede]);

  // Footer height · over-estimated so the fullscreen frame never exceeds the
  // screen (alt-screen clips overflow, so under-filling is safe, over-filling
  // clips the status bar). HEADER is the title bar (marginTop + title + rule).
  const PALETTE_ROWS = pickerRows.length ? Math.min(7, pickerRows.length) : fileMatches.length ? Math.min(5, fileMatches.length) : cmdMatches.length ? Math.min(7, cmdMatches.length) : 0;
  const quickRows = quickPicker ? quickPickerRows(quickPicker) : [];
  const quickPickerLimit = Math.min(7, Math.max(1, quickRows.length));
  // The opencode home screen: a fresh fullscreen session centers the wordmark +
  // key commands + the composer mid-screen; the footer keeps only the status bar.
  // The first submitted prompt creates an item → the layout flips to the chat view.
  const homeScreen = fullscreen && welcome && !setupRequired && !panel && !perm;
  homeScreenRef.current = homeScreen;

  // Sleepy idle: 90s with no typing on the home screen → Boo dozes off (rising
  // Z's). Any keystroke re-arms the timer and wakes him via the cleanup.
  useEffect(() => {
    if (!homeScreen) return;
    const t = setTimeout(() => setGhostMood({ face: "sleepy", overlay: "zzz" }), 90_000);
    return () => {
      clearTimeout(t);
      setGhostMood((m) => (m?.face === "sleepy" ? null : m));
    };
  }, [homeScreen, edit.value]);

  let footer = 2; // status line + its top margin
  // Composer is hidden while a panel is open — subtract its rows so the panel is taller.
  // Permission card renders even while a panel is open (it owns the keys), so
  // its rows are budgeted regardless of the panel.
  if (perm) footer += 5; // consent block: marginTop + title + command + options + marginBottom (PermissionPrompt.tsx row contract — keep in lockstep)
  else if (!panel && !homeScreen) footer += 4 + composerRows(edit.value, pageW); // composer (marginTop + pad + WRAPPED input rows + pad + footer hint · Composer.tsx row contract)
  footer += homeScreen ? 0 : PALETTE_ROWS; // on home the palette renders under the centered composer
  // The now block (marginTop + verb row + activity row while busy; 2 on the
  // post-turn linger beat) — Working.tsx row contract.
  if (busy || linger) footer += workingRows(busy);
  if (queued.length) footer += queued.length + 1;
  if (search) footer += 1;
  footer += toasts.length;
  if (quickPicker && quickRows.length) footer += quickPickerLimit + 2; // overlay: header + marginTop + rows
  // Pinned usage strip (/usage): header + context? + limit windows / note + api? + session + marginTop.
  // Memoized: currentUsageView() reads usage.json + accounts from disk, so calling it
  // on every render (every scroll frame / drag event while the strip is open) was a
  // real source of mouse lag. Recompute only when usage data, the active account, or
  // the per-turn token count actually changes — never on scroll/drag.
  const stripView = useMemo(
    () => (statusPinned ? currentUsageView() : null),
    [statusPinned, usageTick, activeCli?.id, tokens, probing], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // Match the ACTIVE subscription by account id (labels can drift — e.g. a boot
  // restore once set it to the bare binary), so the strip never shows a different
  // account's usage. Only fall back to the first entry if there's no active sub.
  const stripSub = stripView ? (stripView.subscriptions.find((s) => s.id === activeCli?.id) ?? (activeCli ? null : stripView.subscriptions[0]) ?? null) : null;
  // Prefer the account that actually ran the last turn (usedAccountRef) over the
  // top-spend default, so switching between GPT / Azure / DeepSeek / etc. shows
  // the right account's data immediately without waiting for spend to accumulate.
  const stripApi = stripView ? ((usedAccountRef.current ? stripView.apiKeys.find((a) => a.id === usedAccountRef.current) : null) ?? stripView.apiKeys[0] ?? null) : null;
  // Same hot-path rule as stripView: turnsLeftForecast calls totalSpentToday(),
  // which reads usage.json from disk — computing it inline in the strip JSX ran
  // that read on every render (every scroll frame while the strip is pinned).
  const stripForecast = useMemo(
    () =>
      stripView
        ? turnsLeftForecast({
            dailyCapUSD: capsRef.current.daily,
            spentTodayUSD: totalSpentToday(),
            sessionUSD: estimateCost(sessionRef.current.turns),
            sessionTurns: sessionRef.current.turns.length,
          })
        : null,
    [stripView, tokens], // eslint-disable-line react-hooks/exhaustive-deps
  );
  if (statusPinned) footer += 2 + (ctxPct != null ? 1 : 0) + (stripSub ? Math.max(1, stripSub.limits?.length ?? 1) : 0) + (stripApi?.spend ? 1 : 0) + (stripApi?.limits?.length ?? 0) + 1;
  const HEADER = 3; // Masthead (marginTop + wordmark·account row + rule) — keep in lockstep with viewportTop 4
  // Keep the whole frame STRICTLY under `rows`. Ink redraws with a full
  // clearTerminal (\x1b[2J\x1b[3J\x1b[H — the 3J wipes SCROLLBACK) the moment the
  // output height reaches the terminal height; under-filling by one row keeps it on
  // the cheap incremental-erase path, which is why exit no longer blanks the
  // pre-launch screen (and rendering is less flickery). cli.tsx also strips any
  // stray 3J as a belt-and-suspenders.
  const transcriptHeight = Math.max(1, rows - HEADER - footer - 1);
  const maxScroll = Math.max(0, lines.length - transcriptHeight);
  const effScroll = atBottomRef.current ? maxScroll : Math.min(scrollTop, maxScroll);
  linesRef.current = lines;
  scrollTopLiveRef.current = effScroll;
  transcriptHeightLiveRef.current = transcriptHeight;
  viewportHeightRef.current = transcriptHeight;
  paletteRowsLiveRef.current = PALETTE_ROWS;
  maxScrollRef.current = maxScroll;
  scrollTopRef.current = effScroll;

  // Command-panel render data (fullscreen overlay). Computed here so the key
  // handler and the renderer agree on line count / row numbers.
  const panelW = width - 2;
  const panelInnerW = Math.max(4, panelW - 2);
  // Only read prefs when a panel is actually open — loadPrefs() is a disk read,
  // and this line used to run on EVERY render (every scroll frame).
  const panelCurrentModel = panel ? (loadPrefs().pinnedModel ?? null) : null;
  let panelStaticLines: Line[] | undefined;
  let panelAccountView: AccountView | undefined;
  let panelModels: PanelModelRow[] | undefined;
  let panelSessions: PanelSessionRow[] | undefined;
  let panelWizardSpec: AddSpec | undefined;
  let panelAccountDetail: AccountDetailViewData | undefined;
  if (panel?.kind === "static") {
    panelStaticLines = itemsToLines(panel.items, panelInnerW);
    panelMaxScrollRef.current = Math.max(0, panelStaticLines.length - panelBodyHeight(transcriptHeight));
  } else if (panel?.kind === "accounts") {
    panelAccountView = buildAccountView(listAccounts(), activeCliRef.current?.id ?? null, importableEnvCreds(), accountStatusCacheRef.current);
    // "__add__" is the logical index-0 row (+ add an account); account rows follow.
    panelAccountSlugsRef.current = ["__add__", ...panelAccountView.rows.map((r) => r.alias)];
  } else if (panel?.kind === "models") {
    panelModels = buildPanelModelRows(panelCurrentModel);
  } else if (panel?.kind === "sessions") {
    panelSessionsRef.current = resumableSessions();
    panelSessions = panelSessionsRef.current.map((s) => {
      const firstAsk = s.items?.find((i: any) => i.kind === "user") as any;
      const lastReply = [...(s.items ?? [])].reverse().find((i: any) => i.kind === "assistant" && i.text) as any;
      return {
        id: s.id, when: sessionWhen(s.updatedAt), turns: s.turns?.length ?? 0,
        title: s.title || "(untitled)", pinned: s.pinned,
        preview: { ask: (firstAsk?.text ?? "").split("\n")[0] ?? "", reply: (lastReply?.text ?? "").split("\n").filter(Boolean).pop() ?? "" },
      };
    });
  } else if (panel?.kind === "wizard" && panel.wizardPhase.phase === "field") {
    panelWizardSpec = specFor(panel.wizardPhase.specId);
  } else if (panel?.kind === "account-detail") {
    const acc = listAccounts().find((a) => a.id === panel.accountId);
    if (acc) {
      panelAccountDetail = {
        id: acc.id,
        label: accountName(acc),
        provider: acc.provider,
        isAzure: acc.provider === "azure" || acc.provider === "azure-foundry",
        endpoint: acc.auth.kind === "azure" ? acc.auth.resourceName : (acc.baseUrl ?? ""),
        healthState: acc.health?.state,
        healthCheckedAt: acc.health?.checkedAt,
        lastUsedAt: acc.lastUsedAt,
      };
    }
  }

  // Keep scrollTop pinned to the bottom as new lines stream in (unless scrolled up).
  useEffect(() => {
    if (atBottomRef.current) setScrollTop(maxScroll);
  }, [lines.length, maxScroll]);

  // Cold-open providers block: when there's no conversation yet and accounts are
  // configured, show their real status + honest balances (a pure, synchronous read;
  // usageTick keeps it fresh after spend changes).
  const coldOpenProviders = welcome && !setupRequired ? buildProvidersView(listAccounts(), accountUsage, Date.now()) : [];
  const coldOpenW = Math.min(Math.max(width - 8, 24), 64);
  const hero = (
    <Box flexDirection="column" alignItems="center">
      {setupRequired ? (
        <SetupSplash state={onboardingState} width={width} skin={ghostSkin} splashSize={splashSize} />
      ) : (
        <>
          <MascotSplash skin={ghostSkin} size={splashSize} mood={ghostMood} />
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
          {coldOpenProviders.length ? (
            <Box marginTop={1} width={coldOpenW}>
              <ProvidersView rows={coldOpenProviders} width={coldOpenW} title="providers" max={6} />
            </Box>
          ) : null}
          {firstRunRef.current ? (
            <Box marginTop={1} flexDirection="column" alignItems="center">
              <Text color={color.faint}>new here? press <Text color={color.accent}>?</Text> for shortcuts · <Text color={color.accent}>shift+tab</Text> cycles modes · <Text color={color.accent}>⌃Y</Text> copies the last reply</Text>
              <Text color={color.faint}>/config inline on for terminal scrollback</Text>
            </Box>
          ) : null}
        </>
      )}
    </Box>
  );

  const paletteAt = (w: number) =>
    pickerRows.length || cmdMatches.length || fileMatches.length ? (
      <Box flexDirection="column">
        <CommandPalette draft={edit.value} selected={selectedPalette} limit={7} rows={pickerRows} width={w} />
        <FilePalette matches={fileMatches} selected={selectedPalette} limit={5} width={w} />
      </Box>
    ) : null;
  const paletteJsx = paletteAt(width);

  // Status-bar click picker overlay (rendered just above the status bar). Shares
  // the CommandPalette renderer with the slash pickers.
  const quickPickerJsx = quickPicker && quickRows.length ? (
    <Box flexDirection="column" marginTop={1}>
      <Box paddingX={1}>
        <Text color={color.accent}>{quickPicker === "model" ? "model" : "effort"}</Text>
        <Text color={color.faint}> · ↑↓ select · ⏎ apply · esc close</Text>
      </Box>
      <CommandPalette draft="" selected={Math.min(quickPickerIndex, quickRows.length - 1)} limit={quickPickerLimit} rows={quickRows} width={fullscreen ? pageW : width} />
    </Box>
  ) : null;

  // The permission prompt OUTRANKS an open panel: its key capture runs first
  // in useInput, so hiding the card while a panel is open would freeze the
  // panel and let esc (the panel-close key) silently DENY the unseen request.
  const composerPlaceholder = setupRequired ? "add a provider with /account add <provider> <api-key>" : mode === "plan" ? "describe what to plan…" : "ask anything";
  const composerAt = (w: number, lift: boolean) => (
    <Composer value={edit.value} cursor={edit.cursor} selectionAnchor={edit.selectionAnchor} placeholder={composerPlaceholder} suggestion={suggestion} busy={busy} width={w} vim={vim} bashMode={bashMode} mode={mode} policy={composerPolicy} branch={branch} provider={composerProvider} model={composerModelName} lift={lift} />
  );
  // Inline keeps full width; fullscreen renders these inside the page column
  // (fsComposerJsx below) so the consent line / composer share the transcript's
  // centered column.
  const composerJsx = perm ? (
    <PermissionPrompt req={perm} width={width} />
  ) : panel || homeScreen ? null : (
    composerAt(width, false)
  );
  // flexShrink=0 on the wrappers: when the frame is over-full, Yoga must squeeze
  // the flexible hero/transcript region — never the input box or the consent
  // line (mirrors Composer.tsx's own flexShrink=0, which a wrapper Box would
  // otherwise defeat).
  const fsComposerJsx = perm ? (
    <Box marginLeft={pageLeft} width={pageW} flexShrink={0}>
      <PermissionPrompt req={perm} width={pageW} />
    </Box>
  ) : panel || homeScreen ? null : (
    <Box marginLeft={pageLeft} width={pageW} flexShrink={0}>
      {composerAt(pageW, true)}
    </Box>
  );

  // The opencode home screen (fullscreen, fresh session): Boo + wordmark + version,
  // a short dim command list, then THE composer floating mid-screen (≤80 cols).
  // Heights are gated against the available region so the centered stack can never
  // overflow the frame (the palette opening swaps the command list for itself).
  const homeW = Math.min(Math.max(width - 8, 24), 80);
  const homeRoom = transcriptHeight - 3 - PALETTE_ROWS; // minus the composer block + any open palette
  const homeSplashSize: "big" | "mini" | "none" = homeRoom >= 36 ? "big" : homeRoom >= 24 ? "mini" : "none";
  const showHomeCommands = PALETTE_ROWS === 0 && homeRoom >= (homeSplashSize === "big" ? 32 : homeSplashSize === "mini" ? 22 : 10);
  const HOME_COMMANDS: [string, string][] = [
    ["/model", "pick a model · auto-routes by default"],
    ["/account", "add a provider or subscription"],
    ["/resume", "continue a previous session"],
    ["/help", "all commands"],
    ["shift+tab", "cycle normal · auto-accept · plan"],
    ["!", "run a shell command"],
  ];
  // Home readiness fact (Broadsheet idle moment): am I set up, and who will
  // answer? One dim line — enabled accounts + the routing policy / pin.
  const readyAccounts = homeScreen ? listAccounts().filter((a) => a.enabled).length : 0;
  const homePin =
    selectorKind === "subscription" ? (activeCli?.label ?? "subscription") :
    selectorKind === "fixed" ? (model?.label ? `${model.label} pinned` : "pinned") :
    "auto-routing";
  // The home composer's mouse geometry: the centered group's row heights, added
  // up. Splash height is fixed by AnimatedGhost's constant-height contract
  // (always 1× now: marginTop + 11-row ghost block + wordmark/tagline = 15 ·
  // "none" = wordmark+tagline = 3). PTY-verified; keep in lockstep with homeJsx
  // below and MascotSplash.
  {
    const homeLineCount = composerRows(edit.value, homeW); // display rows (soft wrap)
    const splashH = homeRoom >= 4 ? (homeSplashSize === "none" ? 3 : 15) : 0;
    const readinessH = homeRoom >= 8 ? 2 : 0;
    const commandsH = showHomeCommands ? 1 + HOME_COMMANDS.length : 0;
    const groupH = splashH + readinessH + commandsH + 4 + homeLineCount + PALETTE_ROWS; // composer block (lift=false) = 4 + N
    // The REAL centered region is one row taller than transcriptHeight (which
    // carries a deliberate -1 over-estimate so the frame never exceeds rows).
    // Math.round, not floor: Yoga rounds the centering offset to the nearest
    // row with .5 going UP (an odd leftover puts the extra row on TOP) —
    // PTY-verified at 160x60 (free=15 → topPad 8).
    const topPad = Math.max(0, Math.round((transcriptHeight + 1 - groupH) / 2));
    homeGeomRef.current = homeScreen
      ? {
          firstInputRow: 6 + topPad + splashH + readinessH + commandsH, // header(3) + topPad + content + composer marginTop + pad + 1
          left: Math.floor((width - homeW) / 2),
          width: homeW,
        }
      : null;
  }
  const homeJsx = homeScreen ? (
    <Box flexGrow={1} flexDirection="column" justifyContent="center" alignItems="center">
      {homeRoom >= 4 ? <MascotSplash skin={ghostSkin} size={homeSplashSize} tagline={`v${pkg.version} · one terminal · every model`} mood={ghostMood} /> : null}
      {homeRoom >= 8 ? (
        <Box marginTop={1}>
          <Text color={color.dim}>{readyAccounts} account{readyAccounts === 1 ? "" : "s"} ready · {homePin}</Text>
        </Box>
      ) : null}
      {showHomeCommands ? (
        <Box marginTop={1} flexDirection="column">
          {HOME_COMMANDS.map(([k, d]) => (
            <Text key={k}>
              <Text color={color.accentDim}>{k.padStart(9)}</Text>
              <Text color={color.faint}>  {d}</Text>
            </Text>
          ))}
        </Box>
      ) : null}
      <Box width={homeW} flexDirection="column">
        {composerAt(homeW, false)}
        {/* homeW − 2: inside the centered fixed-width box the palette needs the
            slack or its exactly-fitting rows wrap and break the row budget. */}
        {paletteAt(homeW - 2)}
      </Box>
    </Box>
  ) : null;

  // The fullscreen footer (Broadsheet "one page"): every surface except the
  // full-width meter (StatusBar) sits in the SAME centered page column as the
  // transcript — one Box supplies marginLeft/width, so the row counts are
  // exactly what they were (the wrapper adds zero rows when its children are null).
  const footerJsx = (
    <>
      <Box flexDirection="column" marginLeft={pageLeft} width={pageW}>
        {busy || linger ? (() => { const a = turnActivity(items, pageW); return <Working state={mascotState} verb={verb} elapsed={elapsed} linger={linger && !busy} width={pageW} action={a.action} trail={a.trail} />; })() : null}
        {queued.length ? (
          <Box paddingX={1} marginTop={1} flexDirection="column">
            {queued.map((q, i) => (
              <Text key={i} color={color.faint}>↳ queued: {q.length > 60 ? q.slice(0, 57) + "…" : q}</Text>
            ))}
          </Box>
        ) : null}
        {search ? (
          <Box paddingX={1}>
            <Text wrap="truncate-end">
              <Text color={color.accent}>(reverse-i-search)</Text>
              <Text color={color.text}>`{search.q}`: </Text>
              <Text color={color.dim}>{searchHistory(historyRef.current, search.q, search.idx) ?? (search.q ? "(no match)" : "")}</Text>
            </Text>
          </Box>
        ) : null}
        {toasts.length ? (
          <Box flexDirection="column">
            {toasts.map((t) => (
              <Box key={t.id} paddingX={1} justifyContent="flex-end">
                <Text wrap="truncate-end" color={t.kind === "ok" ? color.ok : t.kind === "err" ? color.err : color.dim}>
                  {t.kind === "ok" ? glyph.check : t.kind === "err" ? glyph.err : glyph.notice} {t.text}
                </Text>
              </Box>
            ))}
          </Box>
        ) : null}
        {quickPickerJsx}
        {statusPinned ? <StatusStrip ctxPct={ctxPct} tokens={tokens} contextWindow={activeCtxWindow} cost={estimateCost(sessionRef.current.turns)} sub={stripSub} subProbing={!!(activeCli && probing.has(activeCli.id))} api={stripApi} forecast={stripForecast!} width={pageW} epoch={themeEpochState} /> : null}
      </Box>
      {/* The command/file palette sits in the page column, aligned with the composer above it. */}
      {homeScreen ? null : <Box height={PALETTE_ROWS} flexDirection="column" marginLeft={pageLeft} width={pageW} flexShrink={0}>{paletteAt(pageW - 2)}</Box>}
      {fsComposerJsx}
      {/* The meter is the page's BOTTOM EDGE — composer above it, one quiet rule
          of truth below everything (cwd:branch · model · ctx · $). statusBarHit
          assumes y === termRows; change in lockstep. */}
      <Box marginLeft={pageLeft} width={pageW} flexShrink={0}>
        <StatusBar model={modelLabel} cost={estimateCost(sessionRef.current.turns)} ctxPct={ctxPct} yolo={yolo} width={pageW} online={online} cwd={rootRef.current} branch={branch} epoch={themeEpochState} />
      </Box>
    </>
  );

  const inlineFooterJsx = (
    <>
      {/* Inline mode has no Viewport/footer frame, so the working strip lives right
          above the composer — otherwise inline shows no "still alive" signal at all
          while a turn runs. Same glow+elapsed as fullscreen, no activity rail. */}
      {busy || linger ? (() => { const a = turnActivity(items, width); return <Working state={mascotState} verb={verb} elapsed={elapsed} linger={linger && !busy} width={width} action={a.action} trail={a.trail} />; })() : null}
      {queued.length ? (
        <Box paddingX={1} marginTop={1} flexDirection="column">
          {queued.map((q, i) => (
            <Text key={i} color={color.faint}>↳ queued: {q.length > 60 ? q.slice(0, 57) + "…" : q}</Text>
          ))}
        </Box>
      ) : null}
      {paletteJsx}
      {composerJsx}
    </>
  );

  if (fullscreen) {
    return (
      <Box flexDirection="column" width={width} height={rows}>
        <Masthead account={bannerAccount} width={width} epoch={themeEpochState} tabRows={tabRows} />
        {/* flexGrow pins the footer (and the composer with it) to the bottom row,
            so however the footer height is estimated, the input bar is always at
            row `rows` — which is what the mouse hit-test (composerOffset) assumes. */}
        {panel ? (
          <Box paddingX={1} flexGrow={1}>
            <Panel panel={panel} width={panelW} height={transcriptHeight} accounts={panelAccountView} models={panelModels} sessions={panelSessions} currentModelId={panelCurrentModel} staticLines={panelStaticLines} wizardSpec={panelWizardSpec} accountDetail={panelAccountDetail} />
          </Box>
        ) : homeScreen ? (
          homeJsx
        ) : welcome ? (
          <Box flexGrow={1} flexDirection="column" justifyContent="center">
            {hero}
          </Box>
        ) : (
          <Box paddingX={1} flexGrow={1}>
            <Viewport lines={lines} scrollTop={effScroll} height={transcriptHeight} width={width - 2} selection={transcriptSelection} />
          </Box>
        )}
        {footerJsx}
      </Box>
    );
  }

  // Inline (the DEFAULT): the terminal owns the screen · native selection,
  // scrollback, and wheel scroll. Finished items commit to scrollback via
  // <Static> (in Transcript); only the live tail + footer re-render.
  const banner = <Banner model={modelLabel} account={bannerAccount} width={width} epoch={themeEpochState} />;
  return (
    <Box flexDirection="column" width={width}>
      {welcome ? (
        <>
          {banner}
          <Box marginTop={1}>{hero}</Box>
        </>
      ) : (
        <Transcript items={displayItems} width={width} header={banner} expandAll={expandAll} />
      )}
      {inlineFooterJsx}
    </Box>
  );
}
