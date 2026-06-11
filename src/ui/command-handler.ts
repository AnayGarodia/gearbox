// The slash-command dispatcher, extracted from App.tsx as a pure motion so
// per-session command handling no longer lives in one component closure (the
// foundation for multi-session/tab support). `CommandCtx` carries everything
// the handler used to close over — refs as-is (they're stable objects),
// setters, and helper callbacks — built fresh per invocation by App.tsx.
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { ModelMessage } from "ai";
import { SKINS, GHOST_LOOKS, isGhostLook, type GhostSkin, type GhostLook, type MascotState } from "./components/Mascot.tsx";
import { setYolo, isYolo } from "../permission.ts";
import { newSessionId, type Session, type TurnMeta } from "../session.ts";
import { setTheme, activeTheme, THEMES } from "./theme.ts";
import { loadPrefs, updatePrefs } from "./prefs.ts";
import type { AccountView, Item } from "./types.ts";
import { FixedSelector, type ModelSelector } from "../model/selector.ts";
import { RoutingSelector, classify } from "../model/router.ts";
import { confirmRoutingPreference, setBudget, loadBudgets, globalPreference, type PreferenceKind, updatePolicy, describePolicy } from "../model/preferences.ts";
import { parsePolicyFast, parsePolicyNL } from "../model/policy-nl.ts";
import { effortLevels, type Effort } from "../model/reasoning.ts";
import { findModel, estimateCost, modelRegistry, refreshModelsDevOverlay, type ModelSpec } from "../providers.ts";
import { truncate, gitConfirmOpen, diffOpen, diffSetText, type PanelState, type PanelModelRow } from "./panel.ts";
import { listAccounts, setDefaultAccount, removeAccount, getAccount, putAccount , uniqueSlug } from "../accounts/store.ts";
import type { Account } from "../accounts/types.ts";
import { importableEnvCreds, importEnvCred, importableCloudCreds, importCloudCred } from "../accounts/detect.ts";
import { addApiKeyAccount, addAzureAccount, addAzureFoundryAccount, addBedrockAccount, addByPastedKey, addOpenAICompatAccount, addVertexAccount, addCliAccount, cliAuthStatus, cliLoginArgs, cliOauthToken } from "../accounts/onboard.ts";
import { buildAddGuidance } from "../accounts/add-spec.ts";
import { discoverModels } from "../accounts/discover.ts";
import { catalogProvider } from "../accounts/catalog.ts";
import { featuredApiKeyProviders, onboardingSummary, type OnboardingState } from "../accounts/onboarding.ts";
import { subscriptionEnv } from "../agent/cli-backend.ts";
import { recordBalance, buildUsageView, totalSpentToday, type UsageView } from "../accounts/usage.ts";
import { readDailySpend, readAuxSpendToday } from "../accounts/ledger.ts";
import * as gitOps from "../git/ops.ts";
import { invalidateGitBranch } from "./git.ts";
import { type BudgetCaps } from "../model/budget-guard.ts";
import { planUndo, type FileChange } from "../undo.ts";
import { fetchBalance, balanceExposed } from "../accounts/balance.ts";
import { buildContext } from "../context/builder.ts";
import { appendFact, loadFacts } from "../context/memory.ts";
import { writeProjectGuide } from "../init.ts";
import { detectVerificationCommands, runVerification, buildCharTestPrompt, type VerifyMode } from "../verify.ts";
import { helpText, formatModelList, resolveModelSwitch, matchCommands, buildContextView, formatAccounts, accountLabel, accountName, accountSlug, ACCOUNT_ADD_HELP, closestCommand } from "../commands.ts";
import { checkHealth, recordHealth, isFresh } from "../accounts/health.ts";
import { addMcpServer, formatMcpConfigList, mcpConfigPaths, mcpToolSummary, reloadMcpConnections, removeMcpServer, shellSplit } from "../mcp.ts";
import { copyToClipboard } from "./clipboard.ts";
import { premiumRate, estimateSavings, formatPolicyString, savingsLine, turnsLeftForecast } from "./cost-tab.ts";
import type { SelectorKind } from "./policy.ts";
import type { ToastKind } from "./toast.ts";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { writeFile as fsWriteFile, unlink as fsUnlink } from "node:fs/promises";
import { computeDiff, diffStat } from "../diff.ts";
import { updateRetrievalFile, resetRetrievalIndex } from "../context/retrieve.ts";
import { editorNames, setEditorPref } from "./links.ts";
import { liveCheckAll, formatDoctorRows } from "../accounts/doctor.ts";
import { searchSessions } from "../session-search.ts";
import { syncModelsDev } from "../model/modelsdev.ts";
import { loadAgents } from "../agents.ts";
import { recordTurnOutcome } from "../model/priors.ts";
import { armDeviceLogin } from "../accounts/azure-arm.ts";
import type { CliModelChoice } from "./App.tsx";

export const KEYS_HELP = [
  "keyboard shortcuts",
  "  ⏎ send · ⌃J newline · esc interrupt · ⌃C twice to quit",
  "  ↑↓ history / move line · ← → cursor · ⌥/⌃ ← → word jump",
  "  ⌃A select all · ⌃E line end · ⌃U / ⌃K kill line · ⌃W kill word · ⌃D forward-delete",
  "  ⌃Y copy last reply · ⌃V paste image from clipboard · shift+tab cycle mode",
  "  ⌃T next tab · click the masthead bar · /tab run <task> · fork · merge (fullscreen)",
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

// System prompts for the /commit and /pr generators (runCompletion, no tools).
const COMMIT_MSG_SYSTEM =
  "You write git commit messages. Given a staged diff, reply with ONLY the commit message: an imperative subject line of at most 72 characters; add a short body (wrapped at 72) after a blank line only when the change genuinely needs explanation. No markdown fences, no surrounding quotes, no trailing period on the subject.";

const PR_SYSTEM =
  "You write GitHub pull-request titles and bodies. Given the branch's commits and a diffstat, reply with the PR title on the first line (at most 80 characters, imperative), then a blank line, then a concise markdown body: what changed and why, with a short bullet list when there are several changes. No placeholders, no fences around the whole reply.";

// Clip generator input so a huge staged diff can't blow the prompt.
export const clipForPrompt = (s: string, max = 8000): string => (s.length > max ? s.slice(0, max) + "\n…(clipped)" : s);

// Split generated git text into subject (first line) + body (the rest).
export const splitSubject = (msg: string): { subject: string; body: string } => {
  const [first, ...rest] = msg.split("\n");
  return { subject: (first ?? "").trim(), body: rest.join("\n").trim() };
};

/**
 * Everything `handleCommand` needs from the App component: refs (stable
 * objects — read/write `.current`), state setters, helper callbacks, and the
 * handful of render-time values the handler reads. Built fresh per invocation
 * (from refs) so there is no staleness risk. Grouped for readability; the
 * members ARE the App component's own — do not redesign them here.
 */
export interface CommandCtx {
  // ── refs (stable objects) ──
  abortRef: MutableRefObject<AbortController | null>;
  accountStatusCacheRef: MutableRefObject<Record<string, { signedIn?: boolean; detail?: string; duplicateOf?: string; identity?: string }>>;
  activeCliModelRef: MutableRefObject<string | undefined>;
  activeCliRef: MutableRefObject<{ id: string; binary: string; profile?: string } | null>;
  askModeRef: MutableRefObject<boolean>;
  atBottomRef: MutableRefObject<boolean>;
  busyRef: MutableRefObject<boolean>;
  capsRef: MutableRefObject<BudgetCaps>;
  charTestOfferedRef: MutableRefObject<boolean>;
  cliSessionRef: MutableRefObject<string | undefined>;
  curAsstRef: MutableRefObject<number | null>;
  effortRef: MutableRefObject<Effort>;
  ghostSkinRef: MutableRefObject<GhostLook>;
  gitDraftRef: MutableRefObject<{ mode: "commit" | "pr"; subject: string; body: string } | null>;
  gitRegenRef: MutableRefObject<{ mode: "commit" | "pr"; system: string; prompt: string; files: string[]; stat: string } | null>;
  idRef: MutableRefObject<number>;
  itemsRef: MutableRefObject<Item[]>;
  lastChangedFilesRef: MutableRefObject<string[]>;
  lastOutcomeKeyRef: MutableRefObject<{ kind: string; modelId: string } | null>;
  lastPromptRef: MutableRefObject<string | null>;
  modeRef: MutableRefObject<"normal" | "auto-accept" | "plan">;
  msgRef: MutableRefObject<ModelMessage[]>;
  notifyRef: MutableRefObject<boolean>;
  panelRef: MutableRefObject<PanelState | null>;
  panelSessionsRef: MutableRefObject<Session[]>;
  resumeListRef: MutableRefObject<Session[]>;
  routedRef: MutableRefObject<{ model: ModelSpec; reason: string } | null>;
  /** conductor tab controls (fullscreen multi-session); absent inline / single-session */
  tabs?: import("./App.tsx").TabControl;
  /** the kind the last auto-routed turn ran with + how it was determined (/why provenance) */
  routedKindRef: MutableRefObject<{ kind: import("../agent/classify.ts").TaskKind; source: string } | null>;
  runTurnRef: MutableRefObject<(prompt: string, attempt?: number) => Promise<void>>;
  selectorRef: MutableRefObject<ModelSelector>;
  sessionRef: MutableRefObject<{ id: string; createdAt: number; title: string; turns: TurnMeta[] }>;
  undoStackRef: MutableRefObject<{ changes: FileChange[]; at: number; checkpoint?: string }[]>;
  /** sha of the session's first turn checkpoint — the /diff baseline (null until a mutation). */
  sessionBaseRef: MutableRefObject<string | null>;
  verifyRef: MutableRefObject<VerifyMode>;
  vimRef: MutableRefObject<"off" | "insert" | "normal">;
  // ── state setters ──
  setActiveCli: Dispatch<SetStateAction<{ id: string; label: string } | null>>;
  setActiveCliModelId: (modelId: string | undefined) => void;
  setBusy: (b: boolean) => void;
  setEffort: (raw: string) => void;
  setGhostSkin: (s: GhostLook) => void;
  setItems: Dispatch<SetStateAction<Item[]>>;
  setLastInput: Dispatch<SetStateAction<number>>;
  setLastPick: Dispatch<SetStateAction<{ model: ModelSpec; reason: string } | null>>;
  setMascotState: Dispatch<SetStateAction<MascotState>>;
  setPanel: (up: PanelState | null | ((p: PanelState | null) => PanelState | null)) => void;
  setSelector: Dispatch<SetStateAction<ModelSelector>>;
  setStatusPinned: (v: boolean) => void;
  setSuggestion: Dispatch<SetStateAction<string | null>>;
  setThemeEpochState: Dispatch<SetStateAction<number>>;
  setTokens: Dispatch<SetStateAction<number>>;
  setVerb: Dispatch<SetStateAction<string>>;
  setVim: (v: "off" | "insert" | "normal") => void;
  setYoloState: Dispatch<SetStateAction<boolean>>;
  // ── helper callbacks (App-owned; passed through, not redesigned) ──
  applyEffortClamp: (allowed: string[]) => string;
  buildAccountView: (
    accounts: Account[],
    activeCliId: string | null,
    importable: { provider: string; label: string; envVar: string }[],
    statuses: Record<string, { signedIn?: boolean; detail?: string; duplicateOf?: string; identity?: string }>,
  ) => AccountView;
  buildPanelModelRows: (cur?: string | null) => PanelModelRow[];
  cliModelChoices: (binary: string) => CliModelChoice[];
  cliModelLabel: (modelId?: string) => string | null;
  cliSupportsModel: (binary: string, modelId: string) => boolean;
  compactNow: (keepRecent: number, signal?: AbortSignal) => Promise<string>;
  echo: (text: string, numbered?: boolean) => void;
  effortTarget: () => { label: string; efforts: string[]; provider: string } | null;
  exit: () => void;
  findAccountRef: (query: string, accounts?: Account[]) => { account?: Account; error?: string };
  flashMood: (face: string, overlay?: "hearts" | "sparkle" | "confetti", ms?: number) => void;
  flashStatus: (text: string) => void;
  formatCliModelList: (binary: string, currentId: string | null) => string;
  generateGitText: (system: string, prompt: string) => Promise<string | null>;
  handleAddResult: (account: Account, initialMessage: string) => Promise<void>;
  leaveSubscription: () => string;
  loadInto: (s: Session) => void;
  notice: (text: string) => void;
  openInfoPanel: (title: string, item: Item) => boolean;
  persist: () => void;
  probeAccountUsage: (a: Account | undefined) => Promise<void>;
  push: (it: Item) => void;
  pushAccounts: (view: AccountView) => void;
  pushPhase: (label: string, detail?: string) => number;
  refreshCliStatuses: () => Promise<void>;
  resolveCliModel: (binary: string, query: string) => { ok: true; modelId: string; label: string } | { ok: false; message: string };
  resumableSessions: () => Session[];
  runInteractive: (cmd: string, cmdArgs: string[], env?: Record<string, string>) => number | null;
  runTurn: (prompt: string, attempt?: number) => Promise<void>;
  sessionWhen: (t: number) => string;
  toast: (text: string, kind?: ToastKind) => void;
  togglePlan: () => void;
  updatePhase: (id: number, state: "running" | "ok" | "err", label: string, detail?: string) => void;
  // ── render-time values (snapshotted when the ctx is built) ──
  activeCli: { id: string; label: string } | null;
  fullscreen: boolean;
  model: ModelSpec | null;
  onboardingState: OnboardingState;
  selectorKind: SelectorKind;
  statusPinned: boolean;
}

export function handleCommand(ctx: CommandCtx, text: string): void {
  // Destructure once: the moved body below is byte-identical to its App.tsx
  // original — every former closure variable resolves through the ctx instead.
  const {
    abortRef, accountStatusCacheRef, activeCliModelRef, activeCliRef, askModeRef, atBottomRef,
    busyRef, capsRef, charTestOfferedRef, cliSessionRef, curAsstRef, effortRef, ghostSkinRef,
    gitDraftRef, gitRegenRef, idRef, itemsRef, lastChangedFilesRef, lastOutcomeKeyRef,
    lastPromptRef, modeRef, msgRef, notifyRef, panelRef, panelSessionsRef, resumeListRef,
    routedKindRef, routedRef, runTurnRef, selectorRef, sessionBaseRef, sessionRef, undoStackRef, verifyRef, vimRef,
    setActiveCli, setActiveCliModelId, setBusy, setEffort, setGhostSkin, setItems, setLastInput,
    setLastPick, setMascotState, setPanel, setSelector, setStatusPinned, setSuggestion,
    setThemeEpochState, setTokens, setVerb, setVim, setYoloState,
    applyEffortClamp, buildAccountView, buildPanelModelRows, cliModelChoices, cliModelLabel,
    cliSupportsModel, compactNow, echo, effortTarget, exit, findAccountRef, flashMood,
    flashStatus, formatCliModelList, generateGitText, handleAddResult, leaveSubscription, loadInto, notice,
    openInfoPanel, persist, probeAccountUsage, push, pushAccounts, pushPhase, refreshCliStatuses,
    resolveCliModel, resumableSessions, runInteractive, runTurn, sessionWhen, toast, togglePlan,
    updatePhase,
    activeCli, fullscreen, model, onboardingState, selectorKind, statusPinned, tabs,
  } = ctx;
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
            let st = await cliAuthStatus(bin, profile, await cliOauthToken(res.account));
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
                const tokenTip = bin === "claude" ? " Or run `claude setup-token` in a terminal and paste the sk-ant-oat… token here as /account add <token> — works for a year, independent of any app login." : "";
                updatePhase(phaseId, "err", `${accountLabel(res.account!)} sign-in`, `didn't complete.${retryDetail} Run ${bin} ${cliLoginArgs(bin).join(" ")}, then /account add ${bin === "codex" ? "codex" : "claude"}${name ? " " + name : ""}.${tokenTip}`);
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
              // AUTO-NAME from the signed-in identity: an unnamed account takes
              // the email's local part as its nickname ("Claude (anay)" →
              // /account claude-anay), so accounts never pile up as anonymous
              // "claude-cli" entries and nobody has to invent a name up front.
              // An explicit name always wins; the slug re-derives from the new
              // label (the id — and every secret/usage ref on it — is untouched).
              const email = (signed.label ?? st.detail ?? "").match(/[^\s·]+@[^\s·]+/)?.[0];
              const local = email?.split("@")[0]?.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
              const autoName = !name && local ? `${res.account!.label.replace(/ \(.*\)$/, "")} (${local})` : null;
              const autoSlug = autoName ? uniqueSlug(autoName, listAccounts().filter((a) => a.id !== acctId).map((a) => a.slug ?? "").filter(Boolean)) : undefined;
              putAccount({ ...res.account!, ...(autoName ? { label: autoName, slug: autoSlug } : {}), identity: signed });
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
          // Fullscreen: the full diff view — changed files vs the session
          // baseline (the first turn checkpoint; HEAD before any mutation),
          // with the selected file's unified diff in a scrollable pane.
          if (fullscreen && gitOps.isRepo()) {
            const base = sessionBaseRef.current;
            const files = gitOps.diffFilesSince(base);
            let p = diffOpen(files, base, base ? "this session" : "working tree vs HEAD");
            if (files.length) p = diffSetText(p, gitOps.fileDiffSince(base, files[0]!.path));
            setPanel(p);
            return;
          }
          // Inline (or no repo): the per-file snapshot diffs, printed.
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
        case "tab": {
          if (!tabs) { echo(text); notice("tabs need fullscreen multi-session mode (run gearbox without --inline)"); return; }
          const [sub, ...restWords] = arg.split(/\s+/).filter(Boolean);
          const rest = restWords.join(" ");
          // No echo for fork: it's also dispatched by the in-stream ⑂ fork
          // click, and the echoed command would pollute BOTH transcripts (the
          // snapshot copies it into the forked history too).
          if (sub !== "fork") echo(text);
          if (!sub || sub === "list") {
            const rows = tabs.list().map((t, i) => `${t.active ? "●" : " "} ${i + 1}  ${t.title}${t.status !== "idle" ? `  · ${t.status}` : ""}\n     ${t.dir}`);
            notice(`tabs (⌃T next · click the bar · /tab new|run|fork|merge|close)\n${rows.join("\n")}`);
            return;
          }
          if (sub === "new") { tabs.create(rest || undefined); return; }
          if (sub === "run") {
            // Spawn-with-a-task: a new session in its own worktree that starts
            // on the prompt immediately — a manual conductor dispatch.
            if (!rest) { notice("usage: /tab run <task> — new tab that starts on the task right away"); return; }
            tabs.create(rest.split(/\s+/).slice(0, 4).join(" "), { task: rest });
            return;
          }
          if (sub === "fork") {
            // Fork THIS conversation into a new tab: full history rides along,
            // then the two sessions diverge in separate worktrees.
            // Unnamed → the conductor derives "<source-tab>-fork" (deduped);
            // passing the session title here made the fork tab a clone of the
            // source tab's name.
            tabs.create(rest || undefined, {
              fork: {
                // ⑂ at the FRONT: a "(fork)" suffix vanished under the tab
                // cell's 14-col truncation, leaving two identical-looking tabs.
                title: sessionRef.current.title ? `⑂ ${sessionRef.current.title}` : "forked session",
                messages: msgRef.current,
                items: itemsRef.current,
                turns: sessionRef.current.turns,
              },
            });
            return;
          }
          if (sub === "merge") {
            // Land this tab's work: commit anything pending on the tab branch,
            // then merge the branch into the BASE tab's checked-out branch.
            const list = tabs.list();
            const self = list.find((t) => t.active);
            const base = list[0];
            if (!self || !base || self.dir === base.dir) { notice("run /tab merge from a session tab (tab 1 is the base it merges into)"); return; }
            if (busyRef.current) { notice("this tab is mid-turn — wait for it to finish before merging"); return; }
            if (base.status === "working") { notice("the base tab is mid-turn — let it finish before merging into its tree"); return; }
            const branch = gitOps.currentBranch(self.dir);
            if (!branch) { notice("couldn't resolve this tab's branch"); return; }
            if (gitOps.status(self.dir).length) {
              gitOps.stageAll(self.dir);
              const c = gitOps.commit(`tab work: ${self.title}`, self.dir);
              if (!c.ok) { notice(`couldn't commit this tab's changes: ${c.err || c.out}`); return; }
            }
            const m = gitOps.git(["merge", "--no-edit", branch], base.dir);
            if (!m.ok) {
              gitOps.git(["merge", "--abort"], base.dir);
              notice(`merge of ${branch} into the base tab hit conflicts — aborted cleanly.\n  resolve manually: cd ${base.dir} && git merge ${branch}`);
              return;
            }
            notice(`✓ merged ${branch} into the base tab\n  /tab close closes this tab · /worktree rm removes its worktree when you're done`);
            return;
          }
          if (sub === "close") { tabs.close(); return; }
          if (sub === "next") { tabs.cycle(1); return; }
          if (sub === "prev") { tabs.cycle(-1); return; }
          const n = parseInt(sub, 10);
          if (Number.isFinite(n) && n >= 1) { tabs.switchTo(n); return; }
          notice("usage: /tab [list | new [name] | run <task> | fork [name] | merge | <n> | next | prev | close]");
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
          // A whole-tree checkpoint covers what per-file snapshots can't: shell
          // deletes, renames, and files the agent mutated outside write/edit.
          if (snap.checkpoint) {
            const r = gitOps.checkpointRestore(snap.checkpoint);
            if (r.ok) {
              gitOps.checkpointDelete(snap.checkpoint);
              resetRetrievalIndex(); // restored files invalidate the lexical index wholesale
              notice(`undid last turn (whole-tree restore to its start; a __pre-restore__ checkpoint holds what you just left)\n  (files only — the conversation is unchanged)`);
              return;
            }
            notice(`checkpoint restore failed (${r.err || "unknown"}) — falling back to per-file snapshots`);
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
            // The MCP connection set is cwd-rooted (.gearbox/mcp.json, .mcp.json):
            // without a reload the new tree's project servers are silently ignored.
            reloadMcpConnections();
            undoStackRef.current = [];
            sessionBaseRef.current = null; // the /diff baseline is per-tree
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
          // Bare /prefer: the whole standing policy in plain English, with undo
          // commands — the single place preferences live.
          if (!arg.trim()) {
            notice(describePolicy().join("\n"));
            return;
          }
          const [kindRaw, modelRaw] = arg.split(/\s+/);
          const allowed = new Set(["code", "search", "summarize", "classify", "plan", "chat"]);
          if (!kindRaw || !modelRaw || !allowed.has(kindRaw)) {
            // Not the structured per-kind form → PLAIN ENGLISH policy. A
            // deterministic parse handles the common phrasings instantly
            // ("no chinese models", "use claude-work before claude-personal",
            // "i have $5k of google credits", "burn google first"); anything
            // else falls to a cheap-model parse. Either way the structured
            // interpretation is echoed back, so nothing is applied silently.
            const pctx = {
              providers: [...new Set([...listAccounts().map((a) => a.provider), ...modelRegistry().map((m) => m.provider)])],
              models: [...new Set(modelRegistry().flatMap((m) => [m.id, m.sdkId]))],
              accounts: listAccounts().map((a) => ({ id: a.id, slug: a.slug ?? a.id })),
            };
            void (async () => {
              const ops = parsePolicyFast(arg, pctx) ?? (await parsePolicyNL(arg, pctx));
              if (!ops) {
                notice([
                  `couldn't turn that into a policy. Say it like:`,
                  `  /prefer no chinese models`,
                  `  /prefer don't use deepseek`,
                  `  /prefer use claude-work before claude-personal`,
                  `  /prefer i have $5000 of google credits`,
                  `  /prefer burn google credits first`,
                  `  /prefer subscriptions only · /prefer no preference`,
                  `or pin a task kind: /prefer code <model>`,
                ].join("\n"));
                return;
              }
              updatePolicy(ops);
              if (selectorRef.current instanceof RoutingSelector) setSelector(new RoutingSelector()); // pick up the new policy now
              notice(`✓ policy updated\n` + describePolicy().join("\n"));
            })();
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
            // Use the kind the last turn ACTUALLY ran with (routedKindRef), not a
            // re-classification: the synchronous keyword fallback defaults bare
            // questions differently than the LLM verdict that routed the turn, so
            // re-deriving here showed a scorecard that disagreed with reality.
            const last = modeRef.current === "plan" ? null : routedKindRef.current;
            const card = sel.explain({ prompt: lastPromptRef.current || "(your next message)", kind: modeRef.current === "plan" ? "plan" : last?.kind });
            push({ kind: "scorecard", id: idRef.current++, card: last ? { ...card, kindSource: last.source } : card });
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
          // The short path: /login claude · /login codex — adds the account if
          // needed, runs the vendor OAuth, done. A name still works for extra
          // accounts (/login claude work). Anything else re-auths by account name.
          const w = arg.trim().toLowerCase().split(/\s+/)[0] ?? "";
          if (["claude", "codex", "chatgpt", "claude-cli", "codex-cli"].includes(w)) {
            signInCli(`${w.startsWith("codex") || w === "chatgpt" ? "codex" : "claude"} ${arg.trim().split(/\s+/).slice(1).join(" ")}`.trim());
            return;
          }
          if (!arg.trim()) {
            notice([
              "sign in:",
              "  /login claude        Claude Pro/Max subscription",
              "  /login codex         ChatGPT Plus/Pro subscription",
              "  paste any API key or `claude setup-token` right into the composer — it's detected and added",
              "  /login <name>        re-auth an existing account",
            ].join("\n"));
            return;
          }
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
}
