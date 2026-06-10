import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdin } from "ink";
import type { ModelMessage } from "ai";
import { Banner } from "./components/Banner.tsx";
import { Transcript } from "./components/Transcript.tsx";
import { StatusBar, statusBarHit, statusBarLayout, formatStatusCost } from "./components/StatusBar.tsx";
import { StatusStrip } from "./components/StatusStrip.tsx";
import { CommandPalette, type PaletteRow } from "./components/CommandPalette.tsx";
import { FilePalette } from "./components/FilePalette.tsx";
import { Composer } from "./components/Composer.tsx";
import { MascotSplash, SKINS, GHOST_LOOKS, isGhostLook, type GhostSkin, type GhostLook, type MascotState } from "./components/Mascot.tsx";
import { PermissionPrompt } from "./components/PermissionPrompt.tsx";
import { Working } from "./components/Working.tsx";
import { Viewport, hullSelection, type ViewSelection } from "./components/Viewport.tsx";
import { itemsToLines, relPath, friendlyTool, fmtElapsed, type Line } from "./lines.ts";
import { collapseTurn, collapseDelegateGroups } from "./collapse.ts";
import { buildRoutingLine } from "./routing-line.ts";
import { policyLabel, type SelectorKind } from "./policy.ts";
import { buildProvidersView } from "./providers-view.ts";
import { ProvidersView } from "./components/ProvidersView.tsx";
import { Masthead } from "./components/Masthead.tsx";
import { premiumRate, estimateSavings, formatPolicyString, savingsLine, turnsLeftForecast } from "./cost-tab.ts";
import { setPermissionHandler, setYolo, isYolo, type PermRequest, type PermDecision } from "../permission.ts";
import { newSessionId, saveSession, loadSession, listSessions, deleteSession, updateSessionMeta, loadHistory, appendHistory, type Session, type TurnMeta } from "../session.ts";
import { nextVerb, toolVerbFromName } from "./character.ts";
import { color, glyph, setTheme, activeTheme, THEMES } from "./theme.ts";
import { loadPrefs, updatePrefs } from "./prefs.ts";
import type { AccountView, Item } from "./types.ts";
import type { OnEvent, Usage } from "../agent/events.ts";
import { FixedSelector, type ModelSelector, type ModelChoice } from "../model/selector.ts";
import { classifyFailure, cooldownScope, markExhausted, modelScopedKey, DEFAULT_COOLDOWN_MS } from "../model/cooldown.ts";
import { RoutingSelector, classify } from "../model/router.ts";
import { parseRateHeaders } from "../model/rate-headers.ts";
import { confirmRoutingPreference, setBudget, loadBudgets, globalPreference, type PreferenceKind } from "../model/preferences.ts";
import { effortLevels, normalizeEffort, clampEffort, type Effort } from "../model/reasoning.ts";
import { findModel, estimateCost, hasPricing, modelRegistry, providerAvailable, refreshModelsDevOverlay, type ModelSpec } from "../providers.ts";
import { Panel } from "./components/Panel.tsx";
import { clampIndex, clampScroll, panelBodyHeight, filterModelRows, appendFilter, backspaceFilter, wizardOpen, wizardPickMove, wizardPickFilter, wizardPickBackspace, wizardPickConfirm, wizardFieldEdit, wizardFieldAdvance, wizardIsComplete, wizardBack, truncate, detailOpen, detailSetDeployments, detailSetAvailableModels, detailSetError, detailSetModelsError, detailStartRefresh, detailMoveIndex, detailStartDeploy, detailDeployFilter, detailDeployBackspace, detailDeployMove, detailPickCapacity, detailCapacityMove, detailConfirmCapacity, detailNameEdit, detailNameAdvance, detailIsNameComplete, detailSetSubmitting, detailStartDelete, detailOptimisticRemove, detailBack, detailSetArmReady, type PanelState, type PanelModelRow, type PanelSessionRow, type WizardPanel, type AccountDetailPanel, type AccountDetailViewData } from "./panel.ts";
import { runTask, runCompletion } from "../agent/run.ts";
import { classifyTask, type TaskKind } from "../agent/classify.ts";
import { loadGearboxDocs, buildAskSystem, looksLikeGearboxQuestion } from "../help/ask.ts";
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
import { gitConfirmOpen, gitConfirmEdit, gitConfirmSetSubmitting, gitConfirmError, gitConfirmReady, gitConfirmMessage, type GitConfirmPanel } from "./panel.ts";
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
import { addMcpServer, formatMcpConfigList, mcpConfigPaths, mcpToolSummary, removeMcpServer, shellSplit } from "../mcp.ts";
import { applyKey, applyMouse, extendUnitSelection, offsetAt, sanitizeInputText, selectionRange, type Edit, type MouseClick } from "./input.ts";
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

export type Runner = (opts: {
  prompt: string;
  messages: ModelMessage[];
  onEvent: OnEvent;
  selector: ModelSelector;
  signal: AbortSignal;
  escalate?: number; // prior failed-check count → router climbs to a stronger model
}) => Promise<{ messages: ModelMessage[]; usage: Usage }>;

const KEYS_HELP = [
  "keyboard shortcuts",
  "  ⏎ send · ⌃J newline · esc interrupt · ⌃C twice to quit",
  "  ↑↓ history / move line · ← → cursor · ⌥/⌃ ← → word jump",
  "  ⌃A / ⌃E line start / end · ⌃U / ⌃K kill line · ⌃W kill word · ⌃D forward-delete",
  "  ⌃Y copy last reply · ⌃V paste image from clipboard · shift+tab cycle mode",
  "  tab @file complete · PgUp/PgDn scroll transcript · type while busy to queue",
  "  / commands · @ files · ! shell · # memory · drag/paste image paths · ? this help",
  "  click the model label in the status bar to pick (fullscreen)",
  "  input stays fixed at the bottom; /config inline on uses terminal scrollback",
].join("\n");

/** Serialize the transcript to Markdown for /export. */
function transcriptMarkdown(items: Item[]): string {
  const out: string[] = ["# Gearbox transcript", ""];
  for (const it of items) {
    if (it.kind === "user") out.push("## You", "", it.text, "");
    else if (it.kind === "assistant") out.push("## Gearbox", "", it.text, "");
    else if (it.kind === "tool") out.push(`> \`${it.name}\` ${it.arg}${it.summary ? " · " + it.summary : ""}`, "");
    else if (it.kind === "notice") out.push(`_${it.text}_`, "");
    else if (it.kind === "accounts") {
      out.push("**accounts**", "", `current: ${it.view.current}`);
      for (const r of it.view.rows) out.push(`- ${r.name} (${r.type}) · ${r.status} · /account ${r.alias}`);
      out.push("");
    }
    else if (it.kind === "usage") {
      out.push("**usage · spend & limits**", "");
      for (const a of it.view.subscriptions) {
        const limits = (a.limits ?? []).map((l) => `${l.label} ${typeof l.pct === "number" ? `${l.pct}%` : l.status === "limited" ? "limited" : l.status === "warn" ? "near limit" : "ok"}`).join(" · ");
        out.push(`- ${a.name} (subscription) · ${a.turns} turns${limits ? ` · ${limits}` : ""}`);
      }
      for (const a of it.view.apiKeys) {
        const rate = (a.limits ?? []).map((l) => `${l.label} ${l.pct}%`).join(" · ");
        out.push(`- ${a.name} (API key) · ${a.spend}${a.balanceLeft ? ` · ${a.balanceLeft}` : a.balanceNote ? ` · ${a.balanceNote}` : ""}${rate ? ` · ${rate}` : ""} · ${a.turns} turns · ${a.tok}`);
      }
      out.push(`- total API spend ${it.view.totalApiSpend}`, "");
    } else if (it.kind === "context") {
      out.push("**context · what's loaded**", "");
      for (const r of it.view.rows) out.push(`- ${r.label.trim()} · ${r.display.trim()}`);
      out.push(`- total ${it.view.total.trim()}${it.view.windowPct != null ? ` (${it.view.windowPct}% of ${it.view.windowLabel})` : ""}`, "");
    } else if (it.kind === "error") out.push(`**error:** ${it.text}`, "");
  }
  return out.join("\n");
}

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

type CliModelChoice = { id: string; label: string; provider: string; efforts?: string[] };

// Claude CLI has no --thinking-effort flag · effort is not passed through.
const CLAUDE_CLI_EFFORTS: string[] = [];
const FALLBACK_CODEX_MODELS: CliModelChoice[] = [
  { id: "gpt-5.5", label: "gpt-5.5", provider: "codex", efforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.4", label: "gpt-5.4", provider: "codex", efforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.4-mini", label: "gpt-5.4-mini", provider: "codex", efforts: ["low", "medium", "high", "xhigh"] },
];
// A short, human category for a failover narration ("sonnet rate-limited → …").
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

// System prompts for the /commit and /pr generators (runCompletion, no tools).
const COMMIT_MSG_SYSTEM =
  "You write git commit messages. Given a staged diff, reply with ONLY the commit message: an imperative subject line of at most 72 characters; add a short body (wrapped at 72) after a blank line only when the change genuinely needs explanation. No markdown fences, no surrounding quotes, no trailing period on the subject.";
const TITLE_SYSTEM =
  "You title coding sessions. Reply with ONLY a 3-8 word title summarizing what the user is working on — lowercase except proper nouns and code identifiers, no quotes, no trailing period. Example: fix azure deploy 404 in manage.ts";

const PR_SYSTEM =
  "You write GitHub pull-request titles and bodies. Given the branch's commits and a diffstat, reply with the PR title on the first line (at most 80 characters, imperative), then a blank line, then a concise markdown body: what changed and why, with a short bullet list when there are several changes. No placeholders, no fences around the whole reply.";

// Clip generator input so a huge staged diff can't blow the prompt.
const clipForPrompt = (s: string, max = 8000): string => (s.length > max ? s.slice(0, max) + "\n…(clipped)" : s);

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

// A pinned, live "what's it doing NOW" rail (two lines): the current action with
// its target and a ticking elapsed, then a short trail of recent steps. So a long
// agent/tool run reads as alive and legible without chasing the scrolling transcript.
function ActivityRail({ items, width }: { items: Item[]; width: number }) {
  const lastUser = items.map((it, i) => ({ it, i })).reverse().find((x) => x.it.kind === "user")?.i ?? -1;
  const turn = items.slice(lastUser + 1);
  const tools = turn.filter((i): i is Extract<Item, { kind: "tool" }> => i.kind === "tool");
  const phase = [...turn].reverse().find((i) => i.kind === "phase" && i.state === "running") as Extract<Item, { kind: "phase" }> | undefined;
  const running = [...tools].reverse().find((t) => t.status === "running");
  const cur = running ?? tools[tools.length - 1];
  const checks = turn.filter((i): i is Extract<Item, { kind: "verification" }> => i.kind === "verification").slice(-2);
  if (!cur && !phase && !checks.length) return null;

  // Line 1 — what's happening now: action + target + a live ticking elapsed.
  const isShell = !!cur && (cur.name === "run_shell" || cur.name === "command_execution" || cur.name === "Bash");
  const target = cur?.arg ? (isShell ? cur.arg : relPath(cur.arg)).replace(/\n/g, " ").slice(0, Math.max(width - 26, 12)) : "";
  const head = cur ? `${friendlyTool(cur.name)}${target ? " " + target : ""}` : phase ? phase.label : "working";
  const timer = running?.startedAt ? fmtElapsed(Math.floor((Date.now() - running.startedAt) / 1000)) : "";

  // Line 2 — the recent trail (last few steps) + checks, dim. Static glyphs (no
  // spin) — the only animation is the bottom working shimmer.
  const trail = tools.slice(-3).map((t) => `${t.status === "running" ? glyph.running : t.status === "err" ? glyph.cross : glyph.check} ${friendlyTool(t.name)}`).join("  ");
  const checkText = checks.map((c) => `${c.ok ? glyph.check : glyph.cross} ${c.command}`).join("  ");
  const sub = [trail || null, checkText || null].filter(Boolean).join("   ");

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1} width={width}>
      <Box>
        <Text color={color.accentDim}>▸ </Text>
        <Text color={color.text}>{head.slice(0, Math.max(width - 14, 12))}</Text>
        {timer ? <Text color={color.faint}>{"  · " + timer}</Text> : null}
      </Box>
      {sub ? <Text color={color.faint}>{"  " + sub.slice(0, Math.max(width - 4, 12))}</Text> : null}
    </Box>
  );
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
  const onlineRef = useRef(online); // fresh mirror for run callbacks, avoids a stale closure
  onlineRef.current = online;
  // Chrome (title bar, rules, composer, status) spans the full terminal width;
  // long prose wraps at a readable cap inside it (see Transcript).
  const width = columns;
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
  const [ghostSkin, setGhostSkinState] = useState<GhostLook>(() => { const g = loadPrefs().ghost; return g && isGhostLook(g) ? g : "base"; });
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
  // The flywheel's recording hooks: what kind routed this turn, and the last
  // edited turn's (kind, model) so /undo can debit it as a human revert.
  const routedKindRef = useRef<string | null>(null);
  // WIRE TRUTH: the model id the provider's response says served the last
  // turn. The routing line cross-checks this against what we requested.
  const servedModelRef = useRef<string | null>(null);
  // Last turn's non-history context overhead (system/memory/repomap/retrieval),
  // so auto-compact triggers on the full context, not history alone. 0 until an
  // in-loop turn has built a context (CLI turns don't run buildContext).
  const ctxOverheadRef = useRef(0);
  const lastOutcomeKeyRef = useRef<{ kind: string; modelId: string } | null>(null);
  const capsRef = useRef<BudgetCaps>(loadPrefs().budgetCaps ?? {}); // hard spend ceilings (/cap)
  const undoStackRef = useRef<{ changes: FileChange[]; at: number }[]>([]); // per-turn file snapshots for /undo + /diff
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

  // Reflect status in the terminal window/tab title (OSC 2).
  useEffect(() => {
    const proj = basename(process.cwd());
    setTitle(busy ? `✳ ${proj} · working` : `${proj} · gearbox`);
  }, [busy]);

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
  const ghostSkinRef = useRef<GhostLook>(loadPrefs().ghost && isGhostLook(loadPrefs().ghost!) ? loadPrefs().ghost! : "base");
  const permRef = useRef<PermRequest | null>(null);
  const permQueue = useRef<{ req: PermRequest; resolve: (d: PermDecision) => void }[]>([]);
  const scrollTopRef = useRef(0);
  const viewportHeightRef = useRef(1);
  const maxScrollRef = useRef(0);
  const paletteRowsLiveRef = useRef(0); // PALETTE_ROWS, for status-bar click hit-testing
  const homeScreenRef = useRef(false); // fullscreen home screen (composer mid-screen, not at the bottom)
  const statusBarRenderRef = useRef<{ model: string; costText: string; ctxPct: number | null; width: number }>({ model: "", costText: "", ctxPct: null, width: 0 });
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
    const composerPoint = (x: number, y: number): { line: number; col: number; off: number } | null => {
      if (busyRef.current || permRef.current) return null;
      if (homeScreenRef.current) return null; // home screen: the composer floats mid-screen, not at the bottom
      const value = editRef.current.value;
      const lineCount = Math.max(1, value.split("\n").length);
      const firstInputRow = rows - 4 - lineCount;
      const lastInputRow = rows - 5;
      if (y < firstInputRow || y > lastInputRow) return null;
      const line = y - firstInputRow;
      // 1 border + space + prompt + space, SGR coords are 1-based — plus the page
      // column's left offset (the composer sits in the centered page column).
      const col = Math.max(0, x - 5 - pageLeftRef.current);
      return { line, col, off: offsetAt(value, line, col) };
    };
    // Which status-bar label, if any, sits under this click. Row + column math
    // lives in the pure, tested statusBarHit; here we only supply live layout.
    const statusBarZoneAt = (x: number, y: number): "model" | null => {
      const { model, costText, ctxPct, width: w } = statusBarRenderRef.current;
      if (homeScreenRef.current) {
        // Home screen: the composer lives mid-screen, so the status bar is the
        // very last row (marginTop + bar, nothing below it).
        if (y !== rows || !model) return null;
        const { modelZone } = statusBarLayout({ model, costText, ctxPct, width: pageWRef.current });
        const col = x - 1 - pageLeftRef.current; // the meter lives in the page column now
        return col >= modelZone[0] && col < modelZone[1] ? "model" : null;
      }
      const value = editRef.current.value;
      const lineCount = Math.max(1, value.split("\n").length);
      return statusBarHit({ x: x - pageLeftRef.current, y, termRows: rows, composerLines: lineCount, paletteRows: paletteRowsLiveRef.current, model, costText, ctxPct, width: pageWRef.current });
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
          // Status-bar click pickers (fullscreen only). A primary press on the
          // model or effort label toggles its floating picker; a press anywhere
          // else closes an open one before normal click handling resumes.
          if (fullscreen && isPrimary && !isDrag && !up && !busyRef.current && !permRef.current) {
            const zone = statusBarZoneAt(x, y);
            if (zone) {
              setQuickPicker(quickPickerRef.current === zone ? null : zone);
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
            // line/col come from composerPoint — the ONE composer geometry — so
            // the click, the drag anchor (off), and applyMouse always agree.
            const value = editRef.current.value;
            const { line: lineIdx, col } = cp;
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
    stdin.on("data", onData);
    return () => {
      stdin.off?.("data", onData);
    };
  }, [stdin, fullscreen, rows, scrollBy, queueScroll, copyWithFeedback]);

  // Save the current conversation (best-effort) · model-agnostic messages + the UI
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

  // On launch: load persisted prompt history; resume a session if asked (--continue).
  useEffect(() => {
    const h = loadHistory();
    if (h.length) historyRef.current = h;
    if (resumeId) {
      const s = loadSession(resumeId);
      if (s) loadInto(s);
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
  const routing = setupRequired || activeCli ? null : (lastPick?.reason ?? choice?.reason ?? null);
  // Context window of whatever's actually answering: the in-loop model, or — on a
  // subscription — the CLI's window. Claude Code Max runs a 200k window (NOT the
  // registry's 1M API value), so default claude to 200k; codex keeps its larger one.
  const activeCtxWindow = activeCli
    ? (activeCliRef.current?.binary?.includes("codex") ? (findModel(activeCliModel ?? "")?.contextWindow ?? 272_000) : 200_000)
    : model?.contextWindow ?? null;
  const ctxPct = !setupRequired && activeCtxWindow && lastInput > 0 ? Math.round((lastInput / activeCtxWindow) * 100) : null;
  // Mirror exactly what the status bar renders (model + session cost + width), so
  // the click hit-test's right-aligned model zone matches the rendered position.
  statusBarRenderRef.current = { model: modelLabel, costText: formatStatusCost(estimateCost(sessionRef.current.turns)), ctxPct, width };

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
        // On a subscription (no in-loop API), run the grounded answer THROUGH the
        // CLI seat instead of refusing — prepend the docs so it stays grounded and
        // tell the binary not to use tools. (vi)
        const askCli = activeCliRef.current ?? (choice.backend?.kind === "cli" ? { binary: choice.backend.binary, id: choice.backend.account.id, label: choice.model.label, profile: choice.backend.profile, sdkId: choice.model.sdkId } : null);
        if (askCli) {
          const askPrompt = `${buildAskSystem(docs)}\n\nAnswer the following question about Gearbox using ONLY the reference above. Do not use any tools.\n\nQuestion: ${prompt}`;
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
        const r = await runCompletion({ model: choice.model, system: buildAskSystem(docs), prompt, onEvent, signal, creds, maxRetries: onlineRef.current ? 2 : 0 });
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
      type Attempt = { messages: ModelMessage[]; usage: { inputTokens: number; outputTokens: number }; failure?: { message: string; producedOutput?: boolean }; cooldownKey: string };
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
        let { system, messages: ctx, cacheBreak, sections } = buildContext({ history: messages, userText: prompt, userContent, model: choice.model, plan });
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
      if (!routedKind && sel instanceof RoutingSelector && !directiveId) {
        onEvent({ type: "phase", label: "routing", detail: "choosing a model", state: "running" });
        routedKind = await classifyTask(prompt, signal);
      }
      routedKindRef.current = routedKind ?? null;
      let choice: ModelChoice;
      try {
        // interactive: true — this is the foreground turn the user is waiting on, so
        // routing prefers a faster model among bar-clearing candidates (done > FAST >
        // cheap). Delegated sub-tasks and compaction omit it → they stay cheapest.
        choice = directiveId ? new FixedSelector(directiveId).select({ prompt, kind: routedKind, requires }) : sel.select({ prompt, kind: routedKind, requires, escalate, interactive: true });
      } catch {
        choice = sel.select({ prompt, kind: routedKind, requires }); // directive model unavailable → fall back to routing
      }
      // When the user explicitly chose the model (a directive or a /model pin),
      // delegated sub-tasks inherit it instead of re-routing to the cheapest.
      const explicitModelId = directiveId || (sel instanceof FixedSelector ? choice.model.id : undefined);
      // Tokens a FAILED attempt already burned must still be counted (C-A) — they
      // hit the wire. Accumulate across hops so cost/ledger aren't under-counted.
      const prior = { inputTokens: 0, outputTokens: 0 };
      for (let hop = 0; ; hop++) {
        const a = await runAttempt(choice);
        const total = { inputTokens: prior.inputTokens + a.usage.inputTokens, outputTokens: prior.outputTokens + a.usage.outputTokens };
        if (!a.failure) { emitTerminal(false, undefined, total); return { messages: a.messages, usage: total }; }
        prior.inputTokens = total.inputTokens; prior.outputTokens = total.outputTokens; // this attempt burned tokens too
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
          if (failKind !== "other") markExhausted(parkedKey, DEFAULT_COOLDOWN_MS, a.failure.message);
          // "Deployment doesn't exist" on Azure/Foundry: prune that model id from
          // the account so it never shows up again. User can redeploy + /account refresh to restore.
          if (isNotDeployedError(a.failure.message) && !a.cooldownKey.startsWith("env:")) {
            const acc = getAccount(a.cooldownKey);
            if (acc?.models?.includes(choice.model.sdkId)) {
              putAccount({ ...acc, models: acc.models.filter((m) => m !== choice.model.sdkId) });
              notice(`${choice.model.label} isn't deployed on ${acc.slug ?? acc.id} — removed from your model list.\nDeploy it in your Azure portal, then /account refresh to restore it.`);
            }
          }
          emitTerminal(true, a.failure.message, prior); return { messages: a.messages, usage: prior };
        }
        markExhausted(parkedKey, DEFAULT_COOLDOWN_MS, a.failure.message);
        let next: ModelChoice | null = null;
        try { next = sel.select({ prompt, kind: routedKind, requires }); } catch { next = null; }
        const nextAcct = next?.backend?.kind === "cli" ? next.backend.account.id : next?.backend?.kind === "in-loop" && next.backend.account ? next.backend.account.id : next ? `env:${next.model.provider}` : null;
        // Bail only when the router hands back the exact pick we just parked
        // (its zero-candidates fallback) — the same account on a DIFFERENT model
        // is a legitimate hop now that parks can be model-scoped.
        const nextEffectiveKey = next && nextAcct ? (scope === "account" ? nextAcct : modelScopedKey(nextAcct, next.model.id)) : null;
        if (!next || nextEffectiveKey === parkedKey) { emitTerminal(true, a.failure.message, prior); return { messages: a.messages, usage: prior }; }
        onEvent({ type: "phase", label: "failover", detail: `${choice.model.label} ${shortFailure(a.failure.message)} → ${next.model.label}, continuing`, state: "running" });
        // Remember what we fell back FROM so the post-turn routing line can flag the
        // provider fallback (a real "surprising" signal) in amber.
        fellOverFromRef.current = choice.model.label;
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
      const apply = (res: { messages: ModelMessage[]; summarizedTurns: number; before: number; after: number }, how: string): string => {
        msgRef.current = res.messages;
        // The status bar's ctx% reads lastInput from the LAST call — after
        // compaction that's stale (it kept showing the pre-compaction size).
        // Reset it to the new history estimate so the bar reflects reality now.
        setLastInput(res.after);
        const saved = res.before - res.after;
        const savedStr = saved >= 1000 ? `${(saved / 1000).toFixed(1)}k` : String(Math.max(0, saved));
        return `compacted ${res.summarizedTurns} earlier turn${res.summarizedTurns > 1 ? "s" : ""}${how} · ~${savedStr} tokens freed (was ~${Math.round(res.before / 1000)}k, now ~${Math.round(res.after / 1000)}k)`;
      };
      // The model-free fallback: mechanical elision (tool output distilled to
      // one line per call). /compact must ALWAYS be able to shrink the history,
      // even on a subscription-only session with no API-key summarizer.
      const mechanical = (why: string): string => {
        const res = elideHistory(msgRef.current, keepRecent);
        if (!res) return `${why} · nothing left to compact mechanically`;
        return apply(res, ` mechanically (${why})`);
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
      if (!res) return "nothing old enough to compact yet";
      return apply(res, "");
    },
    [],
  );

  const MODE_NOTE: Record<"normal" | "auto-accept" | "plan", string> = {
    normal: "normal mode · I'll ask before writes, edits, and shell",
    "auto-accept": "auto-accept edits · file writes/edits apply without asking (shell still gated)",
    plan: "plan mode · read-only; I'll propose a plan before changing anything",
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
        let modelId = activeCliRef.current?.id ?? routedRef.current?.model.id;
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
        fellOverFromRef.current = null; // per-turn failover signal consumed; reset for the next turn
        flushText(); // commit any buffered text on interrupt (no done/error fired)
        flushToolStreams();
        abortRef.current = null;
        setBusy(false);
        persist();
        // Snapshot this turn's file changes onto the undo stack (/undo, /diff).
        if (turnChanges.length) undoStackRef.current.push({ changes: turnChanges, at: Date.now() });
        const interrupted = interruptedRef.current;
        if (interrupted) {
          notice("interrupted");
          interruptedRef.current = false;
        }
        void emitHook("turn.end", { changedFiles: [...changedFiles], hadError }).catch(() => {});
        // Pause the type-ahead drain after an error or interrupt so queued prompts
        // don't auto-fire into a still-broken state; a successful turn re-enables it (L-C).
        lastTurnFailedRef.current = hadError || interrupted;
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
            const outcomeKind = routedKindRef.current ?? "code";
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

  // Split generated git text into subject (first line) + body (the rest).
  const splitSubject = (msg: string): { subject: string; body: string } => {
    const [first, ...rest] = msg.split("\n");
    return { subject: (first ?? "").trim(), body: rest.join("\n").trim() };
  };

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
            cliSessionRef.current = undefined;
            setLastPick(null);
            // With 2+ usable backends, let routing decide (subscription-first by
            // default): the seat is now a candidate the RoutingSelector prefers
            // until its limit, then falls back to your API keys. Only pin it when
            // it's the sole usable backend (routing over one seat == pinning).
            const otherUsable =
              listAccounts().some((a) => a.enabled && a.id !== acctId) ||
              [process.env.ANTHROPIC_API_KEY, process.env.OPENAI_API_KEY, process.env.GOOGLE_GENERATIVE_AI_API_KEY, process.env.DEEPSEEK_API_KEY].some(Boolean);
            if (otherUsable) {
              activeCliRef.current = null;
              setActiveCli(null);
              updatePrefs({ activeAccount: null });
              updatePhase(phaseId, "ok", `${accountLabel(res.account!)} added`, `routing will prefer this seat (~free) and fall back to your API keys at its limit. /account ${accountSlug(res.account!)} to pin it; /account off anytime.`);
            } else {
              activeCliRef.current = { id: acctId, binary: bin, profile };
              setActiveCli({ id: acctId, label: shortLabel });
              updatePrefs({ activeAccount: acctId }); // restore this subscription next launch
              updatePhase(phaseId, "ok", `${accountLabel(res.account!)} active`, `using ${bin}${st.detail ? `; ${st.detail}` : ""}. Own tools/permissions; /account off returns to API routing`);
            }
          } catch (e: any) {
            updatePhase(phaseId, "err", `${accountLabel(res.account!)} sign-in`, e?.message ?? String(e));
          }
        })();
      };

      // Re-login by account NAME/slug (e.g. /account login claude-work). Resolves
      // the account, then drives signInCli with its provider + nickname. Falls
      // back to treating the arg as a provider word ("claude"/"codex [name]").
      const reloginByRef = (arg: string) => {
        const ref = findAccountRef(arg, listAccounts());
        const a = ref.account ?? (activeCliRef.current ? getAccount(activeCliRef.current.id) : undefined);
        if (a && a.exec === "cli") {
          const nick = accountName(a).match(/\((.*)\)/)?.[1];
          signInCli(`${a.provider.replace(/-cli$/, "")}${nick ? ` ${nick}` : ""}`.trim());
          return;
        }
        if (a && (a.provider === "azure" || a.provider === "azure-foundry")) {
          // Azure accounts CAN sign in: gearbox's own device-code flow issues
          // the management token that deployment create/delete needs — no
          // Azure CLI required. The key stays for inference; this adds ARM.
          notice("starting Azure sign-in (for deployment management)…");
          void armDeviceLogin((info) => {
            notice(`azure sign-in · open ${info.url} and enter code  ${info.userCode}  (expires in ~${info.expiresInMin} min)`);
          }).then((r) => {
            if (r.ok) toast("azure management sign-in complete", "ok");
            else notice(r.note ?? "azure sign-in failed");
          });
          return;
        }
        if (a && a.exec !== "cli") {
          // An API-key account has nothing to re-login · point to switching instead.
          notice(`${accountName(a)} is an API-key account · nothing to re-login. Use /account ${accountSlug(a)} to switch to it, or /account add ${a.provider} <key> to replace the key.`);
          return;
        }
        // Not a known account · treat the arg as the provider form (claude/codex).
        signInCli(arg);
      };

      // Every command runs inside this boundary: a bug in any handler becomes a
      // single clean notice, never a raw stack dumped over the UI or a crash.
      try {
      switch (name) {
        case "exit":
        case "quit":
          persist(); // save the conversation before quitting (only turn-end persisted before — I-D)
          exit();
          return;
        case "clear":
          persist(); // save the outgoing conversation BEFORE resetting, so it's resumable (not silently abandoned)
          setItems([]);
          msgRef.current = [];
          itemsRef.current = [];
          setTokens(0);
          setLastInput(0);
          curAsstRef.current = null;
          routedRef.current = null;
          // Drop the vendor binary's session id too: on a CLI subscription the
          // next turn would otherwise pass --resume <old-id> and the binary
          // would continue the conversation the user just cleared.
          cliSessionRef.current = undefined;
          sessionRef.current = { id: newSessionId(), createdAt: Date.now(), title: "", turns: [] };
          charTestOfferedRef.current = false; // a fresh session may offer the test once again
          gitDraftRef.current = null; // a stale /commit go after /clear would surprise
          gitRegenRef.current = null;
          notice("started a fresh conversation");
          return;
        case "resume": {
          const sessions = resumableSessions();
          resumeListRef.current = sessions;
          if (!arg) {
            if (!sessions.length) {
              echo(text);
              notice("no other saved sessions for this project yet");
              return;
            }
            // Open the interactive picker (↑↓ · ⏎ load) instead of dumping the list
            // into the transcript — one clean UI, consistent with /model and /account.
            // Inline (no panels) falls back to the listed notice.
            if (!fullscreen) {
              echo(text);
              const rows = sessions.slice(0, 10).map((s, i) => `  ${i + 1}. ${sessionWhen(s.updatedAt)} · ${s.turns?.length ?? 0} turn${(s.turns?.length ?? 0) === 1 ? "" : "s"} · ${s.title || "(untitled)"}`).join("\n");
              notice("resume a session · /resume <n>:\n" + rows);
              return;
            }
            atBottomRef.current = true;
            setPanel({ kind: "sessions", title: "resume a session · ⏎ to load", index: 0 });
            return;
          }
          echo(text);
          // A number picks from the last listing; anything else is a SEARCH
          // across every saved session's title + conversation text.
          const n = parseInt(arg, 10);
          if (Number.isFinite(n) && String(n) === arg.trim()) {
            const pick = sessions[n - 1];
            if (!pick) {
              notice(`no session ${arg} · /resume to list`);
              return;
            }
            loadInto(pick);
            return;
          }
          const matches = searchSessions(arg, { limit: 10 });
          if (!matches.length) {
            notice(`no session mentions “${arg}” · /resume to list them all`);
            return;
          }
          const matched = matches
            .map((m) => sessions.find((sx) => sx.id === m.id))
            .filter((sx): sx is NonNullable<typeof sx> => !!sx);
          resumeListRef.current = matched;
          if (fullscreen && matched.length) {
            panelSessionsRef.current = matched;
            atBottomRef.current = true;
            setPanel({ kind: "sessions", title: `sessions matching “${truncate(arg, 24)}” · ⏎ to load`, index: 0 });
            return;
          }
          const rows = matches.map((m, i) => `  ${i + 1}. ${m.title || "(untitled)"} · ${m.turns} turn${m.turns === 1 ? "" : "s"}\n     ${m.snippet}`).join("\n");
          notice(`sessions matching “${arg}” · /resume <n>:\n${rows}`);
          return;
        }
        case "help": {
          const it: Item = { kind: "notice", id: idRef.current++, text: helpText() };
          if (openInfoPanel("help", it)) return;
          echo(text);
          push(it);
          return;
        }
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
            notice(target?.efforts.length ? `effort: ${effortRef.current} · ${target.label} supports ${target.efforts.join(", ")}` : "the active model does not expose reasoning efforts");
          }
          return;
        }
        case "verify": {
          const a = arg.trim().toLowerCase();
          if (a === "test off") {
            echo(text);
            updatePrefs({ offerTests: false });
            notice("characterization-test offers off · /verify test still works on demand");
            return;
          }
          if (a === "test") {
            // Generate a characterization test for the last edited turn's files.
            // Runs as a NORMAL turn (the auto-fix re-entry pattern): the routing
            // seam, permission gate, verification, and cost ledger all apply.
            if (busyRef.current) { notice("busy — wait for the current turn to finish"); return; }
            const files = lastChangedFilesRef.current;
            if (!files.length) { echo(text); notice("nothing changed recently — edit something first, then /verify test"); return; }
            echo(text);
            setTimeout(() => void runTurnRef.current?.(buildCharTestPrompt(files), 0), 0);
            return;
          }
          echo(text);
          if (a === "off") {
            verifyRef.current = "off";
            updatePrefs({ verify: "off" });
            toast("verification off · no post-edit checks, no auto-fix", "info");
          } else if (a === "on" || a === "auto") {
            verifyRef.current = "auto";
            updatePrefs({ verify: "auto" });
            toast("verification auto · checks after edits, auto-fix to green");
          } else {
            const cmds = detectVerificationCommands(process.cwd()).map((c) => c.command);
            notice(
              `verification: ${verifyRef.current}` +
                (cmds.length ? ` · detected: ${cmds.join(", ")}` : " · no test/build/typecheck command detected") +
                `\n  /verify off  ·  /verify auto  ·  /verify test (write a characterization test)`,
            );
          }
          return;
        }
        case "agents": {
          echo(text);
          const defs = loadAgents();
          notice(
            "agents · run one with @<name> <task>\n" +
              defs.map((a) => `  @${a.name.padEnd(14)} ${a.description}${a.model ? ` · pinned to ${a.model}` : ""} · ${a.source}`).join("\n") +
              "\n  add your own: .gearbox/agents/<name>.md (frontmatter: description, model) — body = its system prompt",
          );
          return;
        }
        case "doctor": {
          echo(text);
          notice("live-checking every account (one ~8-token call each)…");
          void liveCheckAll().then((rows) => {
            const it: Item = { kind: "notice", id: idRef.current++, text: formatDoctorRows(rows) };
            if (openInfoPanel("provider health", it)) return;
            push(it);
          });
          return;
        }
        case "cap": {
          echo(text);
          const [which, amountStr] = arg.split(/\s+/);
          const periods = ["session", "daily", "monthly", "total"] as const;
          const fmtCaps = () => {
            const c = capsRef.current;
            const set = periods.filter((p) => c[p] != null).map((p) => `${p} $${c[p]!.toFixed(2)}`);
            return set.length ? set.join(" · ") : "none";
          };
          if (!which) {
            notice(`spend caps: ${fmtCaps()}\n  set one: /cap <session|daily|monthly|total> <amount>  ·  clear: /cap off`);
            return;
          }
          if (which.toLowerCase() === "off") {
            capsRef.current = {};
            updatePrefs({ budgetCaps: {} });
            notice("spend caps cleared");
            return;
          }
          const p = periods.find((x) => x === which.toLowerCase());
          if (!p) {
            notice("cap period must be one of: session · daily · monthly · total");
            return;
          }
          const amount = parseFloat((amountStr ?? "").replace(/^\$/, ""));
          if (!Number.isFinite(amount) || amount <= 0) {
            notice(`give a dollar amount, e.g. /cap ${p} 5`);
            return;
          }
          capsRef.current = { ...capsRef.current, [p]: amount };
          updatePrefs({ budgetCaps: capsRef.current });
          notice(`${p} spend cap set to $${amount.toFixed(2)} · turns refuse once reached (/cap off to clear)`);
          return;
        }
        case "diff": {
          echo(text);
          // Earliest pre-turn content per path across the session's snapshots,
          // compared to what's on disk now — one colored diff per changed file.
          const map = new Map<string, { before: string; existed: boolean }>();
          for (const turn of undoStackRef.current) for (const c of turn.changes) if (!map.has(c.path)) map.set(c.path, { before: c.before, existed: c.existed });
          if (!map.size) {
            notice("no file changes this session");
            return;
          }
          let shown = 0;
          for (const [path, { before }] of map) {
            let current = "";
            try {
              current = readFileSync(resolve(process.cwd(), path), "utf8");
            } catch {
              current = ""; // deleted/missing
            }
            if (current === before) continue;
            const diff = computeDiff(before, current);
            push({ kind: "tool", id: idRef.current++, callId: `diff:${path}`, name: "diff", arg: path, status: "ok", summary: `${path} (${diffStat(diff)})`, diff });
            shown++;
          }
          if (!shown) notice("no net changes (files match their pre-session content)");
          return;
        }
        case "undo": {
          echo(text);
          const snap = undoStackRef.current.pop();
          if (!snap) {
            notice("nothing to undo");
            return;
          }
          // Flywheel: reverting a turn is the costliest verdict on its model.
          if (lastOutcomeKeyRef.current) {
            try { recordTurnOutcome({ ...lastOutcomeKeyRef.current, outcome: "undone" }); } catch { /* best-effort */ }
            lastOutcomeKeyRef.current = null;
          }
          const plan = planUndo(snap.changes);
          void (async () => {
            const done: string[] = [];
            for (const a of plan) {
              const abs = resolve(process.cwd(), a.path);
              try {
                if (a.action === "delete") {
                  await fsUnlink(abs);
                  updateRetrievalFile(a.path, null);
                  done.push(`✗ ${a.path}`);
                } else {
                  await fsWriteFile(abs, a.content, "utf8");
                  updateRetrievalFile(a.path, a.content);
                  done.push(`↩ ${a.path}`);
                }
              } catch (e: any) {
                done.push(`! ${a.path}: ${(e?.message ?? String(e)).split("\n")[0]}`);
              }
            }
            notice(`undid last turn's file changes:\n  ${done.join("\n  ")}\n  (files only — the conversation is unchanged)`);
          })();
          return;
        }
        case "commit": {
          echo(text);
          if (!gitOps.isRepo()) { notice("not a git repository"); return; }
          if (busyRef.current) { notice("busy — wait for the current turn to finish before committing"); return; }
          const a = arg.trim();
          // `/commit go` commits the inline-mode draft and NOTHING else — with
          // no pending draft it must not fall through to the literal-message
          // path (it would create a commit titled "go").
          if (a === "go") {
            const d = gitDraftRef.current;
            if (d?.mode !== "commit") { notice("no pending draft — run /commit first"); return; }
            gitDraftRef.current = null;
            const r = gitOps.commit(d.body ? `${d.subject}\n\n${d.body}` : d.subject);
            invalidateGitBranch();
            notice(r.ok ? `✓ committed · ${gitOps.lastCommits(1)[0] ?? ""}` : `commit failed: ${r.err || r.out}`);
            return;
          }
          if (a && a !== "-a") {
            if (!gitOps.status().some((e) => e.staged)) { notice("nothing staged · stage files first, or /commit -a"); return; }
            const r = gitOps.commit(a);
            invalidateGitBranch();
            notice(r.ok ? `✓ committed · ${gitOps.lastCommits(1)[0] ?? ""}` : `commit failed: ${r.err || r.out}`);
            return;
          }
          if (a === "-a") gitOps.stageAll();
          // Capture the repo root NOW: generation is async, and /worktree use
          // can chdir the whole session mid-flight — the confirm must commit in
          // the tree the message was written for.
          const commitRoot = gitOps.repoRoot() ?? process.cwd();
          const staged = gitOps.status(commitRoot).filter((e) => e.staged);
          if (!staged.length) { notice("nothing staged · /commit -a stages everything first"); return; }
          const stat = gitOps.stagedDiff(commitRoot, { stat: true });
          const statLine = stat.split("\n").filter(Boolean).pop() ?? "";
          const files = staged.map((e) => e.path);
          const genPrompt = clipForPrompt(`${stat}\n\n${gitOps.stagedDiff(commitRoot)}`);
          notice("writing a commit message…");
          void (async () => {
            const gen = await generateGitText(COMMIT_MSG_SYSTEM, genPrompt);
            const fallback = `update ${files.slice(0, 3).map((f) => f.split("/").pop()).join(", ")}${files.length > 3 ? ` +${files.length - 3} more` : ""}`;
            const { subject, body: msgBody } = splitSubject(gen ?? fallback);
            if (gitOps.repoRoot() !== commitRoot) { notice("the workspace moved while the message was being written — run /commit again"); return; }
            gitRegenRef.current = { mode: "commit", system: COMMIT_MSG_SYSTEM, prompt: genPrompt, files, stat: statLine };
            // Don't clobber a panel the user opened while generation ran —
            // fall back to the inline draft flow instead.
            if (fullscreen && !panelRef.current) {
              atBottomRef.current = true;
              setPanel(gitConfirmOpen({ mode: "commit", subject, body: msgBody, files, stat: statLine }));
            } else {
              gitDraftRef.current = { mode: "commit", subject, body: msgBody };
              notice(`commit message:\n  ${subject}${msgBody ? `\n\n${msgBody.split("\n").map((l) => "  " + l).join("\n")}` : ""}\n\n${statLine}\n  /commit go — commit with this · /commit <your message> — use your own`);
            }
          })();
          return;
        }
        case "push": {
          echo(text);
          if (!gitOps.isRepo()) { notice("not a git repository"); return; }
          const branch = gitOps.currentBranch();
          const ab = gitOps.aheadBehind();
          if (ab && ab.ahead === 0) { notice(ab.behind ? `nothing to push · ${ab.behind} behind upstream (pull first)` : "nothing to push — up to date with upstream"); return; }
          const needsUpstream = ab === null;
          const cmdLabel = needsUpstream ? `git push -u origin ${branch ?? "HEAD"}` : "git push";
          const id = idRef.current++;
          const startedAt = Date.now();
          push({ kind: "tool", id, callId: `git:${id}`, name: "run_shell", arg: cmdLabel, status: "running", summary: "", startedAt });
          void (async () => {
            const r = await gitOps.push({
              setUpstream: needsUpstream, branch,
              onChunk: (c) => setItems((prev) => prev.map((i) => (i.id === id && i.kind === "tool" ? { ...i, outputTail: ((i.outputTail ?? "") + c).slice(-3000) } : i))),
            });
            setItems((prev) => prev.map((i) => (i.id === id && i.kind === "tool" ? { ...i, status: r.ok ? "ok" : "err", summary: r.ok ? `pushed ${branch ?? "HEAD"}` : (r.output.split("\n").find((l) => l.trim()) ?? "push failed"), endedAt: Date.now(), durationMs: Date.now() - startedAt, exitCode: r.exitCode } : i)));
          })();
          return;
        }
        case "pr": {
          echo(text);
          if (!gitOps.isRepo()) { notice("not a git repository"); return; }
          const [sub = "list", nArg] = arg.trim().split(/\s+/);
          const action = sub.toLowerCase();
          const ghMissing = () => {
            const url = gitOps.compareUrl();
            notice(`the gh CLI isn't available or signed in — install: brew install gh · then: gh auth login${url ? `\nor open a PR manually: ${url}` : ""}`);
          };
          if (action === "list") {
            if (!gitOps.hasGh()) { ghMissing(); return; }
            const rows = gitOps.prList();
            if (!rows.length) { notice("no open PRs"); return; }
            const listText = rows.map((p) => `#${String(p.number).padEnd(5)} ${p.title}\n       ${p.branch} · ${p.author} · ${p.state.toLowerCase()}`).join("\n");
            const it: Item = { kind: "notice", id: idRef.current++, text: listText };
            if (openInfoPanel("pull requests", it)) return;
            push(it);
            return;
          }
          if (action === "view" || action === "diff") {
            if (!gitOps.hasGh()) { ghMissing(); return; }
            const n = nArg ? parseInt(nArg, 10) : undefined;
            const out = action === "view" ? gitOps.prView(n) : gitOps.prDiff(n);
            if (!out) { notice(`gh returned nothing — is there ${n ? `a PR #${n}` : "a PR for this branch"}?`); return; }
            const it: Item = { kind: "notice", id: idRef.current++, text: out.slice(0, 20_000) };
            if (openInfoPanel(n ? `PR #${n} ${action}` : `PR ${action}`, it)) return;
            push(it);
            return;
          }
          if (action === "go") {
            const d = gitDraftRef.current;
            if (d?.mode !== "pr") { notice("no pending PR draft — run /pr create first"); return; }
            gitDraftRef.current = null;
            notice("creating the PR…");
            void gitOps.prCreate({ title: d.subject, body: d.body }).then((r) =>
              notice(r.ok ? `✓ PR created · ${r.output.split("\n").findLast((l) => /https?:\/\//.test(l)) ?? r.output}` : `PR failed: ${r.output}`));
            return;
          }
          if (action === "create") {
            if (!gitOps.hasGh()) { ghMissing(); return; }
            // Only TRACKED modifications block a PR — untracked scratch files
            // (notes.txt, .env.local) aren't part of it and shouldn't be.
            const dirty = gitOps.status().filter((e) => !e.untracked);
            if (dirty.length) { notice(`uncommitted changes (${dirty.length} file${dirty.length === 1 ? "" : "s"}) · /commit first so the PR contains them`); return; }
            const branch = gitOps.currentBranch();
            const ab = gitOps.aheadBehind();
            // The PR's content is branch-vs-BASE (merge-base with origin's
            // default branch) — upstream-relative queries are empty the moment
            // the branch is pushed, which is the most common /pr create state.
            const contrib = gitOps.branchContribution();
            const commits = contrib?.commits.length ? contrib.commits : ab ? gitOps.unpushedCommits() : gitOps.lastCommits(20);
            if (!commits.length) { notice("nothing on this branch vs the base — commit something first"); return; }
            const diffstat = contrib?.diffstat ?? "";
            const genPrompt = clipForPrompt(`Commits:\n${commits.join("\n")}\n\nDiffstat:\n${diffstat}`);
            const finishCreate = async () => {
              notice("writing the PR title & body…");
              const gen = await generateGitText(PR_SYSTEM, genPrompt);
              const { subject, body: prBody } = splitSubject(gen ?? `${branch}: ${commits[commits.length - 1]?.replace(/^\w+ /, "") ?? "changes"}`);
              gitRegenRef.current = { mode: "pr", system: PR_SYSTEM, prompt: genPrompt, files: commits.slice(0, 8), stat: `${commits.length} commit${commits.length === 1 ? "" : "s"} on ${branch}` };
              if (fullscreen && !panelRef.current) {
                atBottomRef.current = true;
                setPanel(gitConfirmOpen({ mode: "pr", subject, body: prBody, files: commits.slice(0, 8), stat: `${commits.length} commit${commits.length === 1 ? "" : "s"} on ${branch}` }));
              } else {
                gitDraftRef.current = { mode: "pr", subject, body: prBody };
                notice(`PR draft:\n  ${subject}\n\n${prBody.split("\n").map((l) => "  " + l).join("\n")}\n\n  /pr go — create it · /pr create — regenerate`);
              }
            };
            // Unpushed (or upstream-less) work pushes first so the PR sees it.
            if (ab === null || ab.ahead > 0) {
              notice(`pushing ${branch ?? "HEAD"} first…`);
              void gitOps.push({ setUpstream: ab === null, branch }).then((r) => {
                if (!r.ok) { notice(`push failed: ${r.output.split("\n").find((l) => l.trim()) ?? "unknown error"}`); return; }
                void finishCreate();
              });
            } else void finishCreate();
            return;
          }
          notice("usage: /pr [list | create | view [n] | diff [n]]");
          return;
        }
        case "worktree": {
          echo(text);
          if (!gitOps.isRepo()) { notice("not a git repository"); return; }
          const [sub = "list", target] = arg.trim().split(/\s+/);
          const root = gitOps.repoRoot()!;
          const list = gitOps.worktreeList();
          if (sub === "list") {
            notice(list.map((w) => `${w.current ? "● " : "  "}${w.branch ?? `(detached ${w.head})`}  ${w.dir}`).join("\n") + "\n  /worktree add <branch> · use <branch> · rm <branch>");
            return;
          }
          if (sub === "add") {
            if (!target) { notice("usage: /worktree add <branch>"); return; }
            const dir = resolve(root, "..", `${root.split("/").pop()}-wt-${target.replace(/[^\w.-]+/g, "-")}`);
            const r = gitOps.worktreeAdd(dir, target);
            notice(r.ok ? `✓ worktree ready · ${target} at ${dir}\n  /worktree use ${target} — switch this session into it` : `worktree add failed: ${r.err || r.out}`);
            return;
          }
          const found = target ? list.find((w) => w.branch === target || w.dir === target || w.dir.endsWith(`-wt-${target}`)) : undefined;
          if (sub === "use") {
            if (busyRef.current) { notice("busy — wait for the current turn to finish"); return; }
            if (!found) { notice(`no worktree for "${target ?? ""}" · /worktree list`); return; }
            if (found.current) { notice("already in that worktree"); return; }
            // Re-home the whole session: persist the outgoing conversation, move
            // cwd (tools/shell/repo-map/status bar all read it), drop state that
            // is rooted in the old tree, and start a fresh session + index.
            persist();
            try { process.chdir(found.dir); } catch (e: any) { notice(`couldn't enter ${found.dir}: ${e?.message ?? e}`); return; }
            invalidateGitBranch();
            resetRetrievalIndex();
            undoStackRef.current = [];
            cliSessionRef.current = undefined;
            // Tree-rooted drafts must not survive the move: a /commit draft
            // written for the old tree's diff would commit the NEW tree's
            // staged files verbatim, and /verify test would target old paths.
            gitDraftRef.current = null;
            gitRegenRef.current = null;
            lastChangedFilesRef.current = [];
            sessionRef.current = { id: newSessionId(), createdAt: Date.now(), title: "", turns: [] };
            notice(`switched to worktree · ${found.branch ?? found.dir}\n  ${found.dir}\n  the conversation continues here; file ops, shell, and /resume now live in this tree`);
            return;
          }
          if (sub === "rm") {
            if (!found) { notice(`no worktree for "${target ?? ""}" · /worktree list`); return; }
            if (found.current) { notice("can't remove the worktree you're in · /worktree use another first"); return; }
            const r = gitOps.worktreeRemove(found.dir);
            notice(r.ok ? `✓ removed worktree ${found.branch ?? found.dir}` : `remove failed: ${r.err || r.out}`);
            return;
          }
          notice("usage: /worktree [list | add <branch> | use <branch> | rm <branch>]");
          return;
        }
        case "checkpoint": {
          echo(text);
          if (!gitOps.isRepo()) { notice("not a git repository (checkpoints snapshot via git refs)"); return; }
          const [sub, ...restA] = arg.trim().split(/\s+/).filter(Boolean);
          if (sub === "list") {
            const rows = gitOps.checkpointList().filter((c) => c.name !== "__pre-restore__");
            notice(rows.length
              ? rows.map((c) => `  ${c.name.padEnd(24)} ${c.sha} · ${sessionWhen(c.at)}`).join("\n") + "\n  /checkpoint restore <name> · rm <name>"
              : "no checkpoints yet · /checkpoint [name] saves one");
            return;
          }
          if (sub === "restore") {
            // Restoring rewrites the whole working tree — never under a running
            // agent whose tools are mid-edit in it.
            if (busyRef.current) { notice("busy — wait for the current turn to finish before restoring"); return; }
            const cpName = restA.join(" ");
            if (!cpName) { notice("usage: /checkpoint restore <name>"); return; }
            const r = gitOps.checkpointRestore(cpName);
            if (r.ok) { invalidateGitBranch(); resetRetrievalIndex(); undoStackRef.current = []; }
            notice(r.ok
              ? `✓ restored "${cpName}" · the pre-restore state is saved as checkpoint "__pre-restore__" if you change your mind`
              : `restore failed: ${r.err || r.out}`);
            return;
          }
          if (sub === "rm") {
            const cpName = restA.join(" ");
            if (!cpName) { notice("usage: /checkpoint rm <name>"); return; }
            const r = gitOps.checkpointDelete(cpName);
            notice(r.ok ? `✓ deleted checkpoint "${cpName}"` : `delete failed: ${r.err || r.out}`);
            return;
          }
          const cpName = [sub, ...restA].filter(Boolean).join(" ") || `cp-${new Date().toISOString().slice(5, 16).replace(/[T:]/g, "-")}`;
          const r = gitOps.checkpointSave(cpName);
          notice(r.ok
            ? `✓ checkpoint "${r.out}" saved (whole tree, untracked files included) · /checkpoint restore ${r.out}`
            : `checkpoint failed: ${r.err || r.out}`);
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
        case "keys": {
          const it: Item = { kind: "notice", id: idRef.current++, text: KEYS_HELP };
          if (openInfoPanel("keyboard shortcuts", it)) return;
          echo(text);
          push(it);
          return;
        }
        case "vim": {
          echo(text);
          const on = vimRef.current === "off";
          setVim(on ? "insert" : "off");
          updatePrefs({ vim: on });
          toast(on ? "vim mode on · esc for normal, i to insert" : "vim mode off", "info");
          return;
        }
        case "theme": {
          echo(text);
          const want = arg.trim().toLowerCase();
          if (!want) {
            // Fullscreen: the live-preview gallery (↑↓ tries each palette on the
            // REAL UI, ⏎ keeps it, esc reverts). Inline: list the names.
            if (fullscreen) {
              atBottomRef.current = true;
              setPanel({ kind: "themes", title: "theme · live preview", index: Math.max(0, THEMES.findIndex((t) => t.name === activeTheme())), original: activeTheme() });
              return;
            }
            notice(`theme: ${activeTheme()}\n${THEMES.map((t) => `  ${t.name.padEnd(12)} ${t.hint}`).join("\n")}\n  switch: /theme <name>`);
            return;
          }
          if (!setTheme(want)) {
            notice(`no theme "${want}" · ${THEMES.map((t) => t.name).join(" · ")}`);
            return;
          }
          updatePrefs({ theme: activeTheme() });
          setThemeEpochState((e) => e + 1); // repaint the whole tree in the new palette
          toast(`theme → ${activeTheme()}`);
          flashMood("love", "hearts"); // Boo approves of the new outfit
          if (!fullscreen) notice("already-printed lines keep their colors (inline scrollback is written once)");
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
                `  verify  ${p.verify === "off" ? "off" : "auto"}        run checks after edits and auto-fix to green (also /verify)\n` +
                `  theme   ${p.theme ?? "dark"}        color palette for dark or light terminals (also /theme)\n` +
                `  editor  ${p.editor ?? "vscode"}      clickable file links open here (vscode · cursor · windsurf · zed · off)\n` +
                `  change one: /config <vim|notify|inline|verify|theme|editor> <value>`,
            );
            return;
          }
          const on = /^(on|true|yes|1)$/i.test(val ?? "");
          if (key === "vim") {
            setVim(on ? "insert" : "off");
            updatePrefs({ vim: on });
            toast(on ? "vim mode on · esc for normal, i to insert" : "vim mode off", "info");
          } else if (key === "inline") {
            updatePrefs({ fullscreen: !on });
            notice(`inline mode ${on ? "on" : "off"} · restart gearbox to apply`);
          } else if (key === "notify") {
            notifyRef.current = on;
            updatePrefs({ notify: on });
            toast(`notifications ${on ? "on" : "off"}`, "info");
          } else if (key === "verify") {
            verifyRef.current = on ? "auto" : "off";
            updatePrefs({ verify: on ? "auto" : "off" });
            notice(`verification ${on ? "auto" : "off"}`);
          } else if (key === "editor") {
            const want = (val ?? "").toLowerCase();
            if (!editorNames().includes(want)) { notice(`editor: /config editor <${editorNames().join("|")}> — where clickable file links open`); return; }
            updatePrefs({ editor: want });
            setEditorPref(want);
            toast(`file links open in ${want === "off" ? "nothing (links off)" : want}`, "info");
          } else if (key === "theme") {
            const want = (val ?? "").toLowerCase();
            if (!want || !setTheme(want)) { notice(`theme: /config theme <${THEMES.map((t) => t.name).join("|")}>`); return; }
            updatePrefs({ theme: activeTheme() });
            setThemeEpochState((e) => e + 1);
            toast(`theme → ${activeTheme()}`);
          } else {
            notice("settings: vim · notify · inline · verify · theme · editor");
          }
          return;
        }
        case "yolo": {
          echo(text);
          const next = !isYolo();
          setYolo(next);
          setYoloState(next);
          notice(next ? "yolo mode ON · all file writes and shell commands run without asking" : "yolo mode off · back to asking before writes/edits/shell");
          return;
        }
        case "ghost": {
          echo(text);
          if (!arg) {
            // The wardrobe: skins + personas with live preview on the splash.
            // Inline mode has no panel overlay — fall back to cycling skins.
            if (fullscreen) {
              setPanel({ kind: "ghosts", title: "Boo · live preview", index: Math.max(0, GHOST_LOOKS.findIndex((l) => l.value === ghostSkinRef.current)), original: ghostSkinRef.current });
              return;
            }
            const next = SKINS[(SKINS.indexOf(ghostSkinRef.current as GhostSkin) + 1) % SKINS.length]!;
            setGhostSkin(next);
            updatePrefs({ ghost: next });
            notice(`Boo is feeling ${next}.`);
            return;
          }
          const q = arg.toLowerCase().trim();
          const look = isGhostLook(q) ? q : isGhostLook(`persona:${q}`) ? `persona:${q}` : null;
          if (!look) {
            notice(`unknown look: ${arg} · try ${GHOST_LOOKS.map((l) => l.label).join(", ")}`);
            return;
          }
          setGhostSkin(look);
          updatePrefs({ ghost: look });
          notice(`Boo is feeling ${look.replace("persona:", "")}.`);
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
        case "ask": {
          const question = arg.trim();
          if (!question) {
            echo(text);
            notice("usage: /ask <question about Gearbox>  ·  e.g. /ask how do I add Azure?");
            return;
          }
          if (busyRef.current) {
            echo(text);
            notice("finish the current turn first, then /ask");
            return;
          }
          // Route the next turn through the docs-grounded path; echo just the
          // question so it reads like a normal exchange.
          askModeRef.current = true;
          void runTurn(question);
          return;
        }
        case "model":
          if (arg.trim().toLowerCase() === "refresh") {
            echo(text);
            notice("syncing the model catalog from models.dev…");
            void syncModelsDev({ maxAgeMs: 0 }).then((entries) => {
              refreshModelsDevOverlay();
              toast(`model catalog synced · ${entries.length} models known`);
            }).catch(() => notice("catalog sync failed — offline? the cached catalog stays in effect"));
            return;
          }
          // Bare /model on an API setup → the interactive picker panel (fullscreen).
          // Subscriptions keep the inline CLI list; /model <name> still pins inline.
          // Only open the panel when there are API models to show (else fall through
          // to the inline path, which explains how to add a provider).
          if ((!arg || arg.toLowerCase() === "all") && !activeCliRef.current && fullscreen && buildPanelModelRows().length > 0) {
            setPanel({ kind: "models", title: "models · ⏎ to pin", index: 0, filter: "" });
            return;
          }
          echo(text);
          if (!arg || arg.toLowerCase() === "all") {
            const routing = selectorRef.current instanceof RoutingSelector;
            const activeSub = activeCliRef.current;
            const mode = activeSub
              ? `now: ${activeSub.binary} subscription${activeCliModelRef.current ? ` · ${cliModelLabel(activeCliModelRef.current)}` : ""} · /account off for API routing`
              : routing ? "now: routing on · Gearbox picks per task" : `now: pinned to ${currentId ?? "one model"} · /model auto to route`;
            const list = activeSub ? formatCliModelList(activeSub.binary, activeCliModelRef.current ?? null) : formatModelList(currentId, arg.toLowerCase() === "all");
            notice(list + `\n\n  ${mode}`);
            return;
          }
          if (arg.toLowerCase() === "auto" || arg.toLowerCase() === "route") {
            if (activeCliRef.current) {
              setActiveCliModelId(undefined);
              // "/model auto" on a subscription does NOT turn on routing (the seat
              // still owns the turn) — it just clears the pinned seat model. Say so
              // plainly so it doesn't read as "routing is now on". (R-8)
              notice(`still on the ${activeCliRef.current.binary} subscription · cleared the pinned model, it'll use its default. Routing isn't on while a subscription is active — /account off to auto-route across API keys.`);
              return;
            }
            const left = leaveSubscription();
            setSelector(new RoutingSelector());
            setLastPick(null);
            routedRef.current = null;
            updatePrefs({ pinnedModel: undefined }); // remember: routing, across sessions
            notice("routing on · Gearbox now picks the model per task (the cheapest that can do the job)" + left);
            return;
          }
          {
            const cli = activeCliRef.current;
            if (cli) {
              // Try the active subscription's OWN seats FIRST — "/model opus-4.8"
              // (or "opus") on a Claude subscription should pin the subscription's
              // opus seat (free), NOT silently drop to the metered API. We only fall
              // to the API registry below when the subscription can't serve the model
              // (e.g. "/model gpt-4o" while on Claude → resolveCliModel fails → API).
              const cr = resolveCliModel(cli.binary, arg);
              if (!cr.ok) {
                // Not a subscription model · try the full API registry (e.g. /model haiku while on a subscription).
                const r = resolveModelSwitch(arg);
                if (r.ok && r.modelId) {
                  const left = leaveSubscription();
                  setSelector(new FixedSelector(r.modelId));
                  setLastPick(null);
                  routedRef.current = null;
                  updatePrefs({ pinnedModel: r.modelId });
                  flashMood("wink");
                  const newSpec2 = findModel(r.modelId);
                  const effortSuffix2 = applyEffortClamp(newSpec2 ? effortLevels(newSpec2) : []);
                  notice(`${r.message} · pinned (left subscription).${left}${effortSuffix2}`);
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
              notice(`subscription model → ${cr.label} · using ${cli.binary}; tools and permissions still owned by the subscription${effortSuffix}`);
              return;
            }
            const r = resolveModelSwitch(arg);
            if (r.ok && r.modelId) {
              const left = leaveSubscription();
              setSelector(new FixedSelector(r.modelId));
              setLastPick(null);
              routedRef.current = null;
              updatePrefs({ pinnedModel: r.modelId }); // persist the pin across sessions
              flashMood("wink");
              const newSpec = findModel(r.modelId);
              const effortSuffix = applyEffortClamp(newSpec ? effortLevels(newSpec) : []);
              notice(`${r.message} · pinned (persists across sessions). /model auto to route per task again.${left}${effortSuffix}`);
              const kind = classify(lastPromptRef.current ?? "").replace("code", "code") as PreferenceKind;
              push({ kind: "preference", id: idRef.current++, text: `Remember ${r.modelId} for ${kind} tasks?`, acceptCommand: `/prefer ${kind} ${r.modelId}` });
            } else {
              // Fork-in-the-road instead of a dead end: if there's no API key but a
              // subscription can serve this model's family, offer the switch.
              const wanted = modelRegistry().find((m) => [m.id, m.label].some((s) => s.toLowerCase() === arg.toLowerCase() || s.toLowerCase().includes(arg.toLowerCase())));
              const fam = wanted && /claude|anthropic/i.test(`${wanted.provider} ${wanted.id}`) ? "claude-cli" : wanted && /openai|gpt|^o\d/i.test(`${wanted.provider} ${wanted.id}`) ? "codex-cli" : null;
              const sub = fam ? listAccounts().find((a) => a.provider === fam && a.enabled) : null;
              if (sub && wanted) {
                notice(`${r.message}\n\nyou have a ${accountName(sub)} subscription · use it with /account ${accountSlug(sub)}, or add a key: /account add ${wanted.provider} <key>`);
              } else {
                notice(r.message);
              }
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
          // A preference only takes effect under routing. If a model is pinned
          // (FixedSelector) or a subscription is active, switching selectors here
          // would either be a silent no-op (the old bug) or yank their pin — so
          // save it and say plainly when it applies.
          if (selectorRef.current instanceof RoutingSelector) {
            setSelector(new RoutingSelector()); // re-instantiate so the new pref is read
            notice(`remembered: prefer ${pref.modelId} for ${pref.kind} tasks`);
          } else {
            notice(`remembered: prefer ${pref.modelId} for ${pref.kind} tasks · applies once routing is on (/model auto${activeCliRef.current ? " · /account off to leave the subscription" : ""})`);
          }
          return;
        }
        case "budget": {
          echo(text);
          const parts = arg.split(/\s+/).filter(Boolean);
          if (parts.length === 0) {
            const b = loadBudgets();
            const keys = Object.keys(b);
            notice(
              keys.length
                ? "budgets (estimates remaining = budget − tracked spend):\n" + keys.map((k) => `  ${k}: $${b[k]!.amountUSD} ${b[k]!.period}`).join("\n")
                : "no budgets set. /budget <provider|account> <amount> [monthly|total] · lets routing estimate remaining credit for providers that don't expose a balance",
            );
            return;
          }
          const [target, amountRaw, periodRaw] = parts;
          if (amountRaw && /^off$/i.test(amountRaw)) {
            setBudget(target!, null);
            notice(`cleared budget for ${target}`);
            return;
          }
          const amount = Number(amountRaw);
          if (!target || !amountRaw || !Number.isFinite(amount) || amount <= 0) {
            notice("usage: /budget <provider|account> <amountUSD> [monthly|total]  ·  /budget <target> off");
            return;
          }
          const period = periodRaw && /^total$/i.test(periodRaw) ? "total" : "monthly";
          setBudget(target, { amountUSD: amount, period });
          notice(`budget set: ${target} → $${amount} ${period}. Routing will preserve it as it runs low (estimated from your spend).`);
          return;
        }
        case "memory": {
          if (arg) {
            echo(text);
            notice(appendFact(arg) ? "remembered" : "couldn't save that note");
            return;
          }
          const facts = loadFacts().trim();
          const it: Item = { kind: "notice", id: idRef.current++, text: facts ? "remembered facts:\n" + facts : "no remembered facts yet · add one with #<note> or /memory <note>" };
          if (openInfoPanel("memory", it)) return;
          echo(text);
          push(it);
          return;
        }
        case "context": {
          // Route with the REAL last prompt, not "" — an empty prompt classifies as
          // "code" and picks a 1M-window model, so /context showed "1% of 1000.0k"
          // while haiku (200k) was actually answering.
          const m = (() => { try { return selectorRef.current.select({ prompt: lastPromptRef.current || "" }).model; } catch { return null; } })();
          if (!m) {
            echo(text);
            notice("no model available · add a provider first\n\n" + onboardingSummary(onboardingState));
            return;
          }
          // Window of what actually answers (status-bar parity): subscription → the
          // CLI window (claude Max is 200k, NOT the registry's 1M); else the model's.
          const cliNow = activeCliRef.current;
          const ctxWindow = cliNow
            ? (cliNow.binary?.includes("codex") ? (findModel(activeCliModelRef.current ?? "")?.contextWindow ?? 272_000) : 200_000)
            : m.contextWindow;
          const { sections } = buildContext({ history: msgRef.current, userText: lastPromptRef.current || "(your next message)", model: m, plan: modeRef.current === "plan" });
          const it: Item = { kind: "context", id: idRef.current++, view: buildContextView(sections, ctxWindow, process.cwd()) };
          if (openInfoPanel("context", it)) return;
          echo(text);
          push(it);
          return;
        }
        case "why": {
          echo(text);
          const sel = selectorRef.current;
          if (!sel.explain) {
            notice("routing is off · a model or subscription is pinned. Use /model auto to route per task, then /why.");
            return;
          }
          try {
            const card = sel.explain({ prompt: lastPromptRef.current || "(your next message)", kind: modeRef.current === "plan" ? "plan" : undefined });
            push({ kind: "scorecard", id: idRef.current++, card });
          } catch (e: any) {
            notice(e?.message ?? "couldn't build the scorecard");
          }
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
        // Everything account-related, addressed by name/slug:
        //   /account              → list accounts
        //   /account <name>       → switch to account by name/slug (fuzzy match)
        //   /account add …        → sign in (claude/codex) or paste an API key
        //   /account remove <name>→ remove account by name/slug
        //   /account off          → leave the active subscription
        case "accounts":
        case "account": {
          // Bare /account → the interactive panel (fullscreen). Subcommands
          // (/account 2, add, remove, refresh…) fall through to the inline path.
          if (!arg.trim() && fullscreen) {
            setPanel({ kind: "accounts", title: "accounts · ⏎ to switch", index: 0 });
            // Refresh sign-in identities (email · plan) in the background, then
            // re-render the open panel so it shows who each subscription seat is.
            void refreshCliStatuses().then(() => {
              if (panelRef.current?.kind === "accounts") setPanel({ ...panelRef.current });
            });
            return;
          }
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
                // Best-effort probe of API-key accounts with stale health.
                await Promise.all(
                  fresh.filter((a) => a.exec !== "cli" && !isFresh(a.health, Date.now())).map(async (a) => {
                    try { const h = await checkHealth(a); recordHealth(a, h.state, h.detail); } catch { /* best-effort */ }
                  }),
                );
                // Re-read to get the freshly recorded health.
                const withHealth = listAccounts();
                pushAccounts(buildAccountView(withHealth, activeCliRef.current?.id ?? null, importableEnvCreds(), statuses));
              } catch (e: any) {
                notice(`couldn't check subscription accounts · ${e?.message ?? String(e)}`);
                pushAccounts(buildAccountView(listAccounts(), activeCliRef.current?.id ?? null, importableEnvCreds(), accountStatusCacheRef.current));
              }
            })();
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
            if (!activeCliRef.current) {
              notice("not on a subscription · already auto-routing across your API keys (/model auto). /account <name> to use a subscription.");
              return;
            }
            const wasSub = activeCliRef.current.binary;
            activeCliRef.current = null;
            setActiveCliModelId(undefined);
            cliSessionRef.current = undefined;
            setActiveCli(null);
            updatePrefs({ activeAccount: null });
            // Returning to in-loop routing: if no model is pinned, auto-routing is
            // now live (it picks the cheapest model that fits each task).
            const auto = selectorRef.current instanceof RoutingSelector;
            notice(
              `left the ${wasSub} subscription.\n` +
              (auto
                ? `auto-routing now: Gearbox picks the cheapest API model that fits each task. /model <name> to pin one · /account <name> to use a subscription again.`
                : `now using ${model?.label ?? "your pinned model"} · /model auto to route per task.`),
            );
            return;
          }
          if (subL === "login") {
            reloginByRef(parts.slice(1).join(" "));
            return;
          }
          if (!["add", "remove", "rm", "import", "off", "login", "refresh"].includes(subL)) {
            const ref = findAccountRef(arg, all);
            if (ref.account) {
              // A disabled account must not be activated — activation bypasses
              // routing/health/failover and would run every turn on it.
              if (ref.account.enabled === false) {
                notice(`${ref.account.slug ?? ref.account.id} is disabled. Remove and re-add it, or use /account refresh.`);
                return;
              }
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
              notice(ACCOUNT_ADD_HELP);
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
              } else if (["bedrock", "aws"].includes(first)) {
                res = await addBedrockAccount(parts[2] ?? "", parts[3] ?? "", parts[4] ?? "");
              } else if (["vertex", "gcp"].includes(first)) {
                res = await addVertexAccount(parts[2] ?? "", parts[3] ?? "", parts[4]);
              } else if (provGiven) res = await addApiKeyAccount(provGiven, keyVal);
              else res = await addByPastedKey(key); // sniffer identifies it or returns a guided message
              if (!res.ok || !res.account) {
                notice(buildAddGuidance(first, res.message));
                return;
              }
              void handleAddResult(res.account, res.message);
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
                notice("nothing to import · no new provider keys or cloud creds found");
                return;
              }
              for (const c of keys) await importEnvCred(c);
              for (const c of cloud) await importCloudCred(c);
              showList();
            })();
            return;
          }
          if (subL === "refresh") {
            // Re-discover the real model set for in-loop accounts (Azure
            // deployments / Foundry / gateway lists) and persist it. Lets accounts
            // added before discovery · or after you create a new deployment · pick
            // up their actual models without re-adding.
            void (async () => {
              const targets = listAccounts().filter((a) => a.enabled && a.exec !== "cli");
              if (!targets.length) {
                notice("no API/cloud accounts to refresh · /account add to add one");
                return;
              }
              notice(`refreshing models for ${targets.length} account${targets.length === 1 ? "" : "s"}…`);
              for (const a of targets) {
                const d = await discoverModels(a);
                if (d.models.length) {
                  putAccount({ ...a, models: d.models });
                  notice(`${accountName(a)}: ${d.models.length} model${d.models.length === 1 ? "" : "s"}`);
                } else {
                  notice(`${accountName(a)}: ${d.note ?? "no models discovered"}`);
                }
              }
            })();
            return;
          }
          // Anything else → show the list (so a stray arg still helps).
          notice(`didn't recognize "/account ${arg}".\n\n` + formatAccounts(all, activeId, importableEnvCreds(), accountStatusCacheRef.current));
          return;
        }
        case "login": {
          echo(text);
          reloginByRef(arg);
          return;
        }
        case "cost":
        case "usage": {
          // Two distinct questions, two surfaces: /usage (fullscreen) toggles the
          // live limits strip ("how close am I to a wall right now"); /cost is the
          // deep money-story card ("where did money go") — daily bars, per-model,
          // per-account, savings — as a panel in fullscreen, a card inline.
          if (fullscreen && name === "usage") {
            const on = !statusPinned;
            setStatusPinned(on);
            // Refresh real 5h/7d % on open (the live strip re-renders, so the async
            // probe result lands) instead of showing the seeded "ok". (xiii)
            if (on) void probeAccountUsage(listAccounts().find((x) => x.id === activeCli?.id && x.exec === "cli"));
            // Transient footer flash (a few seconds) — not a permanent transcript line.
            flashStatus(on ? "usage pinned · /usage to hide" : "usage hidden · /usage to show");
            return;
          }
          const accounts = listAccounts();
          const resolve = (id: string) => {
            const a = getAccount(id);
            if (a) {
              const bin = a.auth.kind === "cli" ? a.auth.binary : undefined;
              return {
                name: accountName(a),
                kind: (a.exec === "cli" ? "sub" : "api") as "sub" | "api",
                provider: a.provider,
                balanceExposed: a.exec !== "cli" && balanceExposed(a.provider),
                limitNote: a.exec === "cli" ? `limits appear after the first ${bin === "codex" ? "Codex" : "Claude"} turn` : undefined,
              };
            }
            if (id === "unknown") return { name: "(unattributed)", kind: "api" as const };
            return { name: id, kind: "api" as const }; // a model id or env-derived label
          };
          const session = estimateCost(sessionRef.current.turns);
          // The money story (formerly the cost tab): attach the 7-day shape,
          // forecast, per-model session breakdown, savings, aux spend, and the
          // policy line to the card so one surface answers it completely.
          const attachStory = (v: UsageView): UsageView => {
            const turns = sessionRef.current.turns;
            v.daily = readDailySpend(7);
            v.forecast = turnsLeftForecast({ dailyCapUSD: capsRef.current.daily, spentTodayUSD: totalSpentToday(), sessionUSD: session, sessionTurns: turns.length });
            v.auxToday = readAuxSpendToday();
            const byModel = new Map<string, { usd: number; turns: number }>();
            for (const t of turns) {
              const cur = byModel.get(t.model) ?? { usd: 0, turns: 0 };
              cur.usd += estimateCost([t]); cur.turns += 1;
              byModel.set(t.model, cur);
            }
            v.perModel = [...byModel.entries()].map(([model, m]) => ({ model, ...m })).sort((a, b) => b.usd - a.usd).slice(0, 6);
            v.savings = savingsLine(session, estimateSavings(turns, premiumRate(modelRegistry()), (t) => estimateCost([t])));
            v.policy = formatPolicyString({ mode: selectorKind, pinnedModel: model?.label, subscriptionLabel: activeCli?.label, prefer: globalPreference()?.prefer, caps: capsRef.current });
            return v;
          };
          // Providers that expose a remaining balance (OpenRouter, Vercel). For
          // the rest the card shows spend, synchronously.
          const withBalance = accounts.filter((a) => a.exec !== "cli" && balanceExposed(a.provider));
          if (!withBalance.length) {
            // No live fetch needed → show the complete card. (Pushing then
            // mutating wouldn't work: a finished card commits to <Static>, which
            // never re-renders · the inline default.)
            const it: Item = { kind: "usage", id: idRef.current++, view: attachStory(buildUsageView(session, resolve, Date.now(), accounts.map((a) => a.id))) };
            if (openInfoPanel("cost", it)) return;
            echo(text);
            push(it);
            return;
          }
          echo(text);
          notice("checking balances…");
          void (async () => {
            for (const a of withBalance) {
              const bal = await fetchBalance(a);
              if (bal?.remainingUSD != null) recordBalance(a.id, bal);
            }
            const it: Item = { kind: "usage", id: idRef.current++, view: attachStory(buildUsageView(session, resolve, Date.now(), accounts.map((a) => a.id))) };
            if (!openInfoPanel("cost", it)) push(it); // ONCE, with balances in
          })();
          return;
        }
        case "compact": {
          echo(text);
          if (busyRef.current) {
            notice("busy · try /compact once the current turn finishes");
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
            } catch (e: any) {
              notice(`compaction failed: ${e?.message ?? "unknown error"} · history unchanged`);
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
            notice("busy · try /init again once the current turn finishes");
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
          const near = matchCommands(`/${name}`).filter((c) => c.name !== `/${name}`)[0]?.name ?? closestCommand(name);
          notice(near ? `no /${name} command · did you mean ${near}?  (/help for all)` : `no /${name} command · type /help to see what's available`);
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

  // Drain the type-ahead queue when a turn finishes — but NOT after an error/interrupt
  // (L-C): auto-firing the next queued prompt into a broken state just error-loops the
  // whole queue. The next manual (successful) turn clears the flag and resumes draining.
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
  }, { isActive: isRawModeSupported });

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
  else if (!panel && !homeScreen) footer += 5; // composer (marginTop + pad + input + pad + footer hint · Composer.tsx row contract)
  footer += homeScreen ? 0 : PALETTE_ROWS; // on home the palette renders under the centered composer
  if (busy || linger) footer += 2; // one-line working strip (+ marginTop) — the meter's ctx gauge carries low-context now (no extra notice row)
  if (busy) footer += 3; // current-turn activity rail (marginTop + action line + trail)
  if (mode !== "normal") footer += 2;
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
    <Composer value={edit.value} cursor={edit.cursor} selectionAnchor={edit.selectionAnchor} placeholder={composerPlaceholder} suggestion={suggestion} busy={busy} width={w} vim={vim} bashMode={bashMode} policy={composerPolicy} branch={branch} provider={composerProvider} model={composerModelName} lift={lift} />
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
        {busy || linger ? <Working state={mascotState} verb={verb} elapsed={elapsed} linger={linger && !busy} width={pageW} /> : null}
        {queued.length ? (
          <Box paddingX={1} marginTop={1} flexDirection="column">
            {queued.map((q, i) => (
              <Text key={i} color={color.faint}>↳ queued: {q.length > 60 ? q.slice(0, 57) + "…" : q}</Text>
            ))}
          </Box>
        ) : null}
        {mode !== "normal" ? (
          <Box paddingX={1} marginTop={1}>
            <Text wrap="truncate-end">
              <Text color={color.accent}>{glyph.notice} {mode === "plan" ? "plan mode" : "auto-accept edits"}</Text>
              <Text color={color.faint}> · {mode === "plan" ? "read-only" : "writes apply without asking; shell still gated"} · shift+tab to cycle</Text>
            </Text>
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
        <StatusBar model={modelLabel} cost={estimateCost(sessionRef.current.turns)} ctxPct={ctxPct} yolo={yolo} width={pageW} online={online} cwd={process.cwd()} branch={branch} epoch={themeEpochState} />
      </Box>
    </>
  );

  const inlineFooterJsx = (
    <>
      {/* Inline mode has no Viewport/footer frame, so the working strip lives right
          above the composer — otherwise inline shows no "still alive" signal at all
          while a turn runs. Same glow+elapsed as fullscreen, no activity rail. */}
      {busy || linger ? <Working state={mascotState} verb={verb} elapsed={elapsed} linger={linger && !busy} width={width} /> : null}
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
        <Masthead account={bannerAccount} width={width} epoch={themeEpochState} />
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
