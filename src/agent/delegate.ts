/**
 * Task delegation: the orchestrator hands self-contained sub-tasks to fresh
 * sub-agents, each running on the model the router selects as best and
 * cheapest for that specific task (any configured provider, so "DeepSeek for
 * code, Haiku for digest" falls out of the scorer with no special-casing).
 *
 * Two tools are exported via makeDelegateTools:
 *
 *   delegate
 *     Runs one sub-task sequentially in the main workspace. The sub-agent
 *     gets full file and shell tools, produces a written report, and returns
 *     it as the tool result. Live progress streams up as a single replacing
 *     status line so the orchestrator is never blocked by a silent sub-agent.
 *
 *   delegate_parallel
 *     Fans out 2-6 independent sub-tasks concurrently. Each sub-agent runs in
 *     its own isolated git worktree (seeded with the parent's current
 *     uncommitted edits) so concurrent writes cannot collide. When all
 *     sub-agents finish, their changes are merged back into the main workspace:
 *       - Files touched by exactly one sub-agent are applied directly.
 *       - Files touched by more than one sub-agent are 3-way auto-merged.
 *         Non-overlapping edits combine cleanly; truly overlapping edits leave
 *         conflict markers for the orchestrator to resolve.
 *     Worktrees are always cleaned up in a finally block, even on error.
 *
 * Depth limit: these tools are only given to depth-0 turns. Sub-agents (depth
 * > 0) never receive them, so delegation cannot recurse.
 *
 * Cycle prevention: this module never imports run.ts. Instead, the runTask
 * function injects itself via the SubAgentRunner type, breaking the cycle
 * (run.ts imports delegate.ts, not the other way around).
 */
import { tool, type Tool } from "ai";
import { z } from "zod";
import { copyFileSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { RoutingSelector, classify } from "../model/router.ts";
import { FixedSelector } from "../model/selector.ts";
import { detectProofTier } from "../verify.ts";
import { resolveCreds } from "../accounts/resolve.ts";
import { recordSpend, resolveTurnCost } from "../accounts/ledger.ts";
import type { ModelSpec } from "../providers.ts";
import { spawnSyncProc } from "../proc.ts";
import { runCliTask, cliScratchDir } from "./cli-backend.ts";
import type { Account } from "../accounts/types.ts";
import type { ResolvedCreds } from "../accounts/types.ts";
import type { OnEvent, Usage } from "./events.ts";
import { differentiatingSlice } from "../truncate.ts";
import { roleByName, roleRoutingSignals, type RoleSpec } from "./roles.ts";
import { partitionIntoWaves } from "./fanout.ts";
import { classifyFailure, cooldownScope, cooldownMsFor, markExhausted, modelScopedKey } from "../model/cooldown.ts";

/**
 * The function signature that run.ts injects into makeDelegateTools as the
 * sub-agent executor. Keeping this as an injected callback rather than a
 * direct import breaks the run.ts <-> delegate.ts import cycle.
 */
export type SubAgentRunner = (p: {
  model: ModelSpec;
  creds?: ResolvedCreds;
  system: string;
  prompt: string;
  onEvent: OnEvent;
  signal?: AbortSignal;
  root?: string; // workspace root for the sub-agent (a parallel sub-agent's git worktree)
  // Role scoping (src/agent/roles.ts), forwarded to the sub-agent's runTask:
  plan?: boolean; // read-only role (explore/review) — no mutating tools
  allowTools?: string[]; // strict tool allowlist for the role
  denyTools?: string[]; // tool denylist for the role
  effort?: string; // role's default reasoning effort
}) => Promise<{ text: string; usage: Usage; failure?: { message: string } }>;

const KIND = z.enum(["code", "search", "summarize", "classify", "plan", "chat"]);
const ROLE = z.enum(["explore", "review", "code"]);

// System prompt given to every sub-agent. It is intentionally minimal: the
// sub-agent does not see the parent conversation, only its task description.
const SUBAGENT_SYSTEM = [
  "You are a sub-agent inside Gearbox, handling ONE delegated task. You do NOT see the parent conversation — everything you need is in the task description, and there is no user to ask: never end with a question; make the most reasonable assumption, note it in your report, and proceed.",
  "Use your tools to read the repo before changing it, match the surrounding code's style and conventions, and make the smallest change that completes the task. Stay tightly focused; no unrelated work, refactors, or drive-by fixes.",
  "Verify your changes with the project's own checks (typecheck/tests) when they exist. Report honestly: if a check fails or part of the task could not be done, say exactly what and why — never claim unverified success.",
  "When finished, reply with a short report: first line = one-sentence outcome, then which files you changed, how you verified, and anything the orchestrator needs to know (assumptions, failures, follow-ups).",
].join("\n");

// Monotonic counter used to generate unique tool-call IDs and temp-dir names
// within this process lifetime. Not cryptographically unique, just stable.
let counter = 0;

// ── delegation guards (fix the "orchestrator delegates its WHOLE task to a
// SECOND copy of itself" pathology the user hit) ─────────────────────────────

const wordSet = (s: string): Set<string> => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);

/** True when a delegated `task` is essentially the orchestrator's ENTIRE prompt
 *  (it covers most of the prompt's significant words). Offloading the whole turn
 *  to one sub-agent is pure overhead + context loss — the orchestrator should do
 *  it itself or split it into bounded pieces. */
export function isWholeTask(task: string, orchestratorPrompt: string): boolean {
  const p = wordSet(orchestratorPrompt);
  if (p.size < 5) return false; // too short to judge
  const t = wordSet(task);
  let common = 0;
  for (const w of p) if (t.has(w)) common++;
  return common / p.size >= 0.7;
}

/** When a sub-task routes to the orchestrator's OWN model, a SEQUENTIAL delegate
 *  has neither a cheaper-model nor a concurrency payoff — its only benefit is
 *  CONTEXT ISOLATION: a fresh, focused window, which is exactly how mature
 *  harnesses (Claude Code, Goose) use same-model subagents for read/research and
 *  bounded edits. That benefit is real only for a SUBSTANTIAL sub-task; a tiny
 *  one is strictly cheaper done inline (no round-trip, no lost context). So a
 *  same-model sequential delegate is allowed when the work is sizable — it
 *  touches ≥2 files or pulls a large working set into context — and refused when
 *  it's small. isWholeTask still blocks offloading the entire turn either way. */
export const SAME_MODEL_MIN_TOKENS = 6_000; // ≈ a sizable file's worth of reading
export function sameModelDelegateWorthIt(signals: { touchedFiles: string[]; estTokens: number }): boolean {
  return signals.touchedFiles.length >= 2 || signals.estTokens >= SAME_MODEL_MIN_TOKENS;
}

// The sub-agent's first meaningful output line, used as the tool-end summary.
// This is far more useful than repeating the model label (already shown in the
// tool head), and it fits in the one-line summary slot the UI reserves.
const reportLine = (text: string): string => {
  const l = (text.split("\n").find((x) => x.trim()) ?? "").trim();
  return l.length > 64 ? l.slice(0, 63).trimEnd() + "…" : l;
};

/**
 * Build a structured digest of a sub-agent's result for the ORCHESTRATOR (not
 * the UI). Includes the first two lines of the report plus the list of files
 * the sub-agent changed.
 *
 * The files list is already computed from git status of the worktree, so it
 * costs nothing extra. Without it, the orchestrator would need to re-read or
 * re-delegate just to discover what changed, wasting a full turn.
 */
const subAgentDigest = (text: string, changed: { path: string }[]): string => {
  const outcome = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(" ")
    .slice(0, 220);
  const files = changed.map((c) => c.path);
  const filesStr = files.length
    ? ` · changed: ${files.slice(0, 8).join(", ")}${files.length > 8 ? `, +${files.length - 8} more` : ""}`
    : " · no file changes";
  return (outcome || "(no report)") + filesStr;
};

// One-line task preview for the tool head: collapse whitespace and truncate at
// a word boundary, stripping a dangling quote/backtick/punctuation so the
// display never ends on a half-token (e.g. the '... test/tokens.test.ts for `'
// cut-off that looks like broken syntax).
const clipTask = (s: string, max: number): string => {
  const one = s.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  const cut = one.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return (at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,.;:`'"(–-]+$/, "") + "…";
};

// ── routing a sub-task ────────────────────────────────────────────────────────

type Routed = {
  model: ModelSpec;
  account?: Account;
  // The CURATED model this pick mirrors when model.id is a seat/alias — used to
  // compare against the orchestrator's model canonically (the same-model guard).
  canonicalId?: string;
  // Set when the sub-task is hosted by a vendor subscription seat (S-B): the
  // sub-agent then runs through the vendor binary (its own loop + tools) in the
  // sub-task's workspace root, instead of the in-loop API.
  cli?: { binary: string; profile?: string; account: Account };
};

// File-extension allowlist for the path sniffer: a bare token without a slash is
// only treated as a file when its extension is a recognized source/text/config
// type. This keeps "v0.17.2", "claude-sonnet-4-6", "e.g.", "3.5" out of the
// touched-file set while still catching "README.md" or "package.json".
const FILE_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "rb", "c",
  "cc", "cpp", "cxx", "h", "hpp", "cs", "php", "swift", "kt", "kts", "scala",
  "json", "jsonc", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "md",
  "mdx", "txt", "sh", "bash", "zsh", "fish", "sql", "css", "scss", "sass",
  "less", "html", "htm", "xml", "vue", "svelte", "lua", "r", "jl", "ex", "exs",
  "clj", "hs", "ml", "dart", "proto", "graphql", "gql", "lock", "gradle", "tf",
]);

/**
 * Pull file-path-like tokens out of a free-text sub-task description. A
 * delegated task names the files it acts on ("fix the race in src/pool.ts",
 * "add tests for model/router.ts"), and those names are exactly the locality
 * signal the router wants — so we sniff them here rather than leaving the
 * sub-task's difficulty starved (it has no session history of edited files like
 * the top-level turn does).
 *
 * Pure and conservative: a candidate is kept only when it contains a path
 * separator OR ends in a recognized source extension, so prose ("e.g.") and
 * version strings ("v0.17.2", "4.6") are not mistaken for files. Capped at 20
 * (the router slices there too) and de-duplicated, order-preserving.
 */
export function parseTouchedFiles(task: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // token: a path-ish run ending in a letter-led extension. The leading char is
  // restricted so we don't swallow a preceding word's punctuation.
  const re = /(?<![\w/.@~-])([\w@~][\w./@~-]*?\.[A-Za-z][A-Za-z0-9]{0,7})(?![\w-])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(task))) {
    const tok = m[1]!;
    if (/^[a-z]+:\/\//i.test(tok)) continue; // a URL, not a local file
    const hasSlash = tok.includes("/");
    const ext = tok.slice(tok.lastIndexOf(".") + 1).toLowerCase();
    if (!hasSlash && !FILE_EXTS.has(ext)) continue; // bare token must be a known file type
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * Derive the router's difficulty signals (touchedFiles + estTokens) for a
 * sub-task purely from its description (+ the workspace root, to size named
 * files). The top-level turn feeds these from session state; a sub-agent has
 * none, so without this a hard delegated CODE task and a one-line digest look
 * identical to the router and both route cheap. estTokens = the instruction's
 * own tokens plus the bytes of every named file the sub-agent will read into
 * context (a small nominal when a file can't be stat'd), so a task over large/
 * central code clears a higher bar than "summarize this diff".
 */
export function deriveSubTaskSignals(task: string, root?: string): { touchedFiles: string[]; estTokens: number } {
  const named = parseTouchedFiles(task);
  // Resolve relative paths against the sub-task's workspace root so the router's
  // statSync (and our own byte estimate) find the file in a worktree where
  // process.cwd() is not the root. Absolute paths and "no root" pass through.
  const touchedFiles = named.map((f) => (root && !isAbsolute(f) ? join(root, f) : f));
  let fileTokens = 0;
  for (const f of touchedFiles) {
    try { fileTokens += Math.ceil(statSync(f).size / 4); } // ~4 bytes/token
    catch { fileTokens += 2_000; } // named but unreadable → a small-file's worth
  }
  const estTokens = Math.ceil(task.length / 4) + fileTokens;
  return { touchedFiles, estTokens };
}

/**
 * Select a model and account for a sub-task. When the user pinned a model
 * (via /model or "use <name>"), that pin is honored so sub-tasks run on the
 * same model the user requested. Otherwise the RoutingSelector auto-picks the
 * best available model for the task kind, which may be a different provider
 * than the parent turn.
 *
 * A CLI-backed pick (vendor subscription seat) is hosted by the vendor binary
 * itself, run one-shot in the sub-task's workspace root — so a subscription-only
 * setup can still delegate (S-B) instead of erroring out.
 */
function routeSubTask(task: string, kind?: z.infer<typeof KIND>, pinnedModelId?: string, root?: string, extra?: { excludeFamily?: string[] }): Routed | { error: string } {
  const k = kind ?? classify(task);
  // Route a sub-task with the SAME economics as a top-level turn: a sub-agent
  // runs in the background (no user waiting → latency-neutral → cheapest among
  // capable) and inherits the workspace's verifier net, so delegated CODE in an
  // untested repo routes cautiously while a tested repo stays cheap-first.
  // Difficulty signals (touchedFiles + estTokens) are sniffed from the task text
  // so a hard, multi-file sub-task clears a higher bar than a one-line digest —
  // without them the router was blind to a sub-task's actual size. excludeFamily
  // (a cross-family review role) routes the sub-task AWAY from the author's vendor.
  const verifierTier = root ? detectProofTier(root) : undefined;
  const { touchedFiles, estTokens } = deriveSubTaskSignals(task, root);
  const base = { prompt: task, kind: k, interactive: false, verifierTier, touchedFiles, estTokens, excludeFamily: extra?.excludeFamily } as const;
  let choice;
  try {
    choice = (pinnedModelId ? new FixedSelector(pinnedModelId) : new RoutingSelector()).select({ ...base, requires: ["tools"] });
  } catch (e: any) {
    // Subscription-only setups land here: seats fail the in-loop `tools` filter
    // (the vendor binary owns its own tools), so the select throws before the
    // cli-backend branch below can ever fire. Retry seat-only — a no-requires
    // select returns the seat on a subscription-only store, while any setup with
    // a tools-capable API model never reaches this catch.
    try {
      const c2 = new RoutingSelector().select(base);
      if (c2.backend?.kind === "cli") {
        return { model: c2.model, cli: { binary: c2.backend.binary, profile: c2.backend.profile, account: c2.backend.account } };
      }
    } catch { /* fall through to the original error */ }
    return { error: `no model available for this sub-task (${e?.message ?? e})` };
  }
  if (choice.backend?.kind === "cli") {
    return { model: choice.model, cli: { binary: choice.backend.binary, profile: choice.backend.profile, account: choice.backend.account } };
  }
  const account = choice.backend?.kind === "in-loop" ? choice.backend.account : undefined;
  return { model: choice.model, account, canonicalId: choice.canonicalId };
}

// ── activity reporting ────────────────────────────────────────────────────────

/**
 * Map a tool name to a short present-tense verb for the live activity line.
 * This keeps the sub-agent from being a silent black box while it works.
 * The function is intentionally free of UI imports; only AgentEvents flow out.
 */
const subVerb = (name: string): string => {
  const n = name.toLowerCase();
  if (n.includes("read")) return "reading";
  if (n === "file_change" || n.includes("write")) return "writing";
  if (n.includes("edit")) return "editing";
  if (n === "run_shell" || n === "command_execution" || n === "bash") return "running";
  if (n.includes("list")) return "listing";
  if (n === "glob") return "globbing";
  if (n === "search") return "searching";
  if (n.includes("verif")) return "verifying";
  return name;
};

// Relativize a file path against the sub-agent's workspace root so the
// activity line shows "reading src/x.ts" not an absolute tmp path.
const relSub = (arg: string | undefined, root?: string): string => {
  const a = (arg ?? "").replace(/\s+/g, " ").trim();
  const base = root ?? process.cwd();
  const rel = a.startsWith(base + "/") ? a.slice(base.length + 1) : a;
  return rel.slice(0, 48);
};

// ── sub-agent failover helpers ────────────────────────────────────────────────

// The account/env key a routed pick bills + parks under (matches the router's
// cooldown filter and the ledger's accountId).
const pickKey = (r: Routed): string => r.account?.id ?? r.cli?.account.id ?? `env:${r.model.provider}`;
const samePick = (a: Routed, b: Routed): boolean => a.model.id === b.model.id && pickKey(a) === pickKey(b);

// Park a pick that failed recoverably, scoped the SAME way the App hop-loop scopes
// it (R-5): billing/credit drains the whole account → park the account; a
// rate/quota throttle is per-model → park (account, model). The router's enumerate
// then routes around it, so the reroute lands on a live candidate.
function parkPick(r: Routed, message: string): void {
  const key = pickKey(r);
  const ms = cooldownMsFor(classifyFailure(message));
  if (cooldownScope(message) === "account") markExhausted(key, ms, message);
  else markExhausted(modelScopedKey(key, r.model.id), ms, message);
}

// ── single sub-agent executor ─────────────────────────────────────────────────

/**
 * Run one routed sub-agent to completion.
 *
 * When `onActivity` is provided, the sub-agent's tool events are translated
 * into a compact single-line status string ("reading src/x.ts, 12 tools") that
 * REPLACES the previous line on each update, keeping the orchestrator's UI
 * tidy. The target path arrives slightly after tool-start (via the tool-stream
 * arg), so both events are observed and the line is updated on each.
 *
 * Spend is recorded against the routed account so usage limits and billing
 * summaries stay accurate for delegated work.
 */
async function runOne(
  run: SubAgentRunner,
  routed: Routed,
  task: string,
  opts: {
    signal?: AbortSignal; root?: string; onActivity?: (line: string) => void; runCli?: typeof runCliTask; role?: RoleSpec;
    // Failover: re-route the sub-task after a recoverable failure (the failed pick
    // is parked first, so this returns the next-best LIVE candidate). A pin returns
    // the same pick → no hop. Omit to disable failover (one shot).
    reroute?: () => Routed | { error: string };
    maxHops?: number; // default 2
  },
): Promise<{ ok: boolean; text: string }> {
  // A role adds its posture: a system addendum (explore/review/implement), and —
  // for an in-loop sub-agent — read-only + tool scoping + a default effort.
  const role = opts.role;
  const system = role ? `${SUBAGENT_SYSTEM}\n\n${role.systemHint}` : SUBAGENT_SYSTEM;
  let tools = 0;
  let verb = "working";
  let target = "";
  const seen = new Set<string>(); // deduplicate tool IDs so the count is per-call, not per-event
  const emit = () => opts.onActivity?.(`${verb}${target ? " " + target : ""}  ·  ${tools} tool${tools === 1 ? "" : "s"}`);
  const subOnEvent: OnEvent = opts.onActivity
    ? (e) => {
        if (e.type === "tool-start") {
          if (!seen.has(e.id)) { seen.add(e.id); tools++; }
          verb = subVerb(e.name);
          target = e.arg ? relSub(e.arg, opts.root) : "";
          emit();
        } else if (e.type === "tool-stream" && e.arg) {
          // The real file path streams in after the initial tool-start arg,
          // so update the target once we have it.
          target = relSub(e.arg, opts.root);
          emit();
        }
      }
    : () => {};

  // One attempt against a SPECIFIC routed pick. Records spend (even on failure, so
  // budget stays accurate); surfaces the failure message so the loop can classify
  // it for failover rather than folding it into the report text.
  const dispatch = async (pick: Routed): Promise<{ ok: boolean; text: string; failure?: string }> => {
    // Subscription-seat host (S-B): the vendor binary runs its own loop + tools in
    // the sub-task's workspace root. The task rides in the prompt (the system slot
    // isn't portable across binaries). Flat-rate seats record $0 spend (S-F).
    if (pick.cli) {
      const acct = pick.cli.account;
      const r = await (opts.runCli ?? runCliTask)({
        binary: pick.cli.binary,
        prompt: `${system}\n\nIf you need scratch space outside the workspace, prefer ${cliScratchDir()} (pre-approved, runs without interruption); other paths still work but will pause for the user's approval. Run git from the current directory — avoid \`git -C <path>\`, which bypasses the pre-approved git commands.\n\nTask:\n${task}`,
        messages: [],
        onEvent: subOnEvent,
        signal: opts.signal,
        modelId: pick.model.sdkId ?? pick.model.id,
        cwd: opts.root,
        profile: pick.cli.profile,
        accountLabel: acct.slug ?? acct.id,
        reloginCommand: `/account login ${acct.slug ?? acct.id}`,
        deferTerminal: true,
      });
      recordSpend({
        accountId: acct.id, model: pick.model.id, source: "delegate",
        inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens,
        ...resolveTurnCost({ modelId: pick.model.id, isSub: true, usage: r.usage }),
        at: Date.now(),
      });
      if (r.failure) return { ok: false, text: `failed: ${r.failure.message}`, failure: r.failure.message };
      const text = r.messages
        .filter((m) => m.role === "assistant")
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join("\n")
        .trim();
      return { ok: true, text: text || "(no report)" };
    }

    const creds = pick.account ? await resolveCreds(pick.account) : undefined;
    const r = await run({
      model: pick.model, creds, system, prompt: task, onEvent: subOnEvent, signal: opts.signal, root: opts.root,
      plan: role?.readOnly, allowTools: role?.tools, denyTools: role?.disallowedTools, effort: role?.effort,
    });
    recordSpend({
      accountId: pick.account?.id ?? `env:${pick.model.provider}`,
      model: pick.model.id, source: "delegate",
      inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens,
      cachedInputTokens: r.usage.cachedInputTokens, cacheCreationInputTokens: r.usage.cacheCreationInputTokens,
      ...resolveTurnCost({ modelId: pick.model.id, isSub: false, usage: r.usage }),
      at: Date.now(),
    });
    if (r.failure) return { ok: false, text: `failed: ${r.failure.message}`, failure: r.failure.message };
    return { ok: true, text: r.text || "(no report)" };
  };

  // Failover cascade: a sub-agent isn't covered by the App hop-loop, so a
  // recoverable failure (rate/quota/credit/auth/timeout) would otherwise just kill
  // the sub-task. Park the failed pick and re-route to another model/account
  // (≤ maxHops). A real error ("other"), a pin with nowhere to go (samePick), or
  // no reroute closure stops immediately — we never hop on a genuine bug.
  let current = routed;
  const maxHops = opts.maxHops ?? 2;
  for (let hop = 0; ; hop++) {
    const res = await dispatch(current);
    if (res.ok || !res.failure || !opts.reroute || hop >= maxHops) return { ok: res.ok, text: res.text };
    if (classifyFailure(res.failure) === "other") return { ok: res.ok, text: res.text };
    parkPick(current, res.failure);
    const next = opts.reroute();
    if (!next || "error" in next || samePick(next, current)) return { ok: res.ok, text: res.text };
    opts.onActivity?.(`${current.model.label} unavailable — retrying on ${next.model.label}`);
    current = next;
  }
}

// ── git worktree isolation (parallel writes) ──────────────────────────────────

function git(args: string[], cwd?: string): { ok: boolean; out: string } {
  const r = spawnSyncProc(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: (r.exitCode ?? 1) === 0, out: r.stdout.toString().trim() };
}

// `cwd` should be the calling session's pinned root: conductor tabs and
// /worktree use mutate the GLOBAL process.cwd(), so defaulting to it would
// resolve the toplevel of whichever tab chdir'd last, not this session's.
function gitToplevel(cwd?: string): string | null {
  const r = git(["rev-parse", "--show-toplevel"], cwd);
  return r.ok && r.out ? r.out : null;
}

function removeWorktree(repoRoot: string, dir: string): void {
  git(["-C", repoRoot, "worktree", "remove", "--force", dir]);
  try { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
}

/**
 * Parse `git status --porcelain` lines into path/deleted pairs. If `stage` is
 * true, `git add -A` runs first so untracked new files appear in the output.
 * Rename entries (A -> B) produce the destination path only.
 */
function changesIn(root: string, stage: boolean): { path: string; deleted: boolean }[] {
  if (stage) git(["-C", root, "add", "-A"]);
  const r = git(["-C", root, "status", "--porcelain"]);
  if (!r.ok || !r.out) return [];
  const out: { path: string; deleted: boolean }[] = [];
  for (const line of r.out.split("\n")) {
    if (!line.trim()) continue;
    // Porcelain is "XY PATH". The shared git() helper TRIMS its output, which
    // strips the leading space of an unstaged status (" M file" → "M file"), so a
    // fixed slice(3) would eat the path's first char. Parse whitespace-tolerantly:
    // the leading non-space glyphs are the status, the rest (after ≥1 space) is the
    // path. Works for staged ("M  file"), unstaged ("M file"), untracked ("?? file").
    const m = line.match(/^(\S{1,2})\s+(.+)$/);
    if (!m) continue;
    const status = m[1]!;
    let path = m[2]!.trim();
    if (path.includes(" -> ")) path = path.split(" -> ")[1]!.trim(); // rename, take the new path
    // git quotes paths that contain spaces
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    if (path) out.push({ path, deleted: status.includes("D") });
  }
  return out;
}

/**
 * Create a git worktree at HEAD and seed it with the parent's current
 * uncommitted changes so every sub-agent starts from the same up-to-date state
 * (not stale HEAD). A baseline commit is made on the seeded state so that each
 * sub-agent's own changes can later be measured against it. Without this,
 * `git status` in the worktree would include the parent's in-flight edits and
 * every worktree would appear to have the same "changes" to merge back.
 */
function addSeededWorktree(repoRoot: string, dir: string): boolean {
  if (!git(["-C", repoRoot, "worktree", "add", "--detach", dir, "HEAD"]).ok) return false;
  // Copy each parent-dirty file into the worktree before committing.
  for (const c of changesIn(repoRoot, false)) {
    const src = join(repoRoot, c.path), dst = join(dir, c.path);
    try {
      if (c.deleted) { if (existsSync(dst)) rmSync(dst, { force: true }); }
      else { mkdirSync(dirname(dst), { recursive: true }); copyFileSync(src, dst); }
    } catch { /* skip a file we can't seed; the sub-agent will see HEAD for it */ }
  }
  git(["-C", dir, "add", "-A"]);
  git(["-C", dir, "commit", "-q", "-m", "gearbox-fanout-baseline", "--no-verify"]);
  return true;
}

/**
 * 3-way auto-merge a file that was edited by multiple sub-agents back into the
 * main workspace. `base` is the shared seed state (the parent's file before
 * any sub-agent ran). Each worktree's version is merged in turn using
 * `git merge-file`. Non-overlapping hunks combine cleanly; genuinely
 * overlapping edits leave standard conflict markers. Returns true when markers
 * were written so the orchestrator knows which files need manual resolution.
 */
function mergeFileBack(repoRoot: string, path: string, dirs: string[]): boolean {
  const baseAbs = join(repoRoot, path);
  const tmps: string[] = [];
  const tmp = (tag: string) => { const p = join(tmpdir(), `gearbox-merge-${++counter}-${tag}`); tmps.push(p); return p; };
  // Use an empty file as the base for files that are new (didn't exist before).
  const base = tmp("base");
  try { copyFileSync(baseAbs, base); } catch { writeFileSync(base, ""); }
  let current = base;
  let conflicted = false;
  try {
    for (const dir of dirs) {
      const other = join(dir, path);
      if (!existsSync(other)) continue;
      // git merge-file exits >0 when it leaves conflict markers; <0 means a
      // hard error. Either way we flag the file as conflicted.
      const r = spawnSyncProc(["git", "merge-file", "-p", current, base, other], { stdout: "pipe", stderr: "pipe" });
      if ((r.exitCode ?? 0) !== 0) conflicted = true;
      const next = tmp("step");
      writeFileSync(next, r.stdout);
      current = next;
    }
    mkdirSync(dirname(baseAbs), { recursive: true });
    copyFileSync(current, baseAbs);
  } catch { conflicted = true; }
  finally { for (const t of tmps) { try { rmSync(t, { force: true }); } catch {} } }
  return conflicted;
}

// ── exported tool factory ─────────────────────────────────────────────────────

export function makeDelegateTools(opts: { onEvent: OnEvent; signal?: AbortSignal; run: SubAgentRunner; pinnedModelId?: string; runCli?: typeof runCliTask; root?: string; onBackground?: (r: { id: number; task: string; ok: boolean; text: string }) => void; orchestratorModelId?: string; orchestratorPrompt?: string; spawnCleanup?: { current?: () => void } }): Record<string, Tool<any, any>> {
  const { onEvent, signal, run, runCli, onBackground, orchestratorModelId, orchestratorPrompt } = opts;

  // ── delegate (sequential, single task) ──────────────────────────────────────
  const delegate = tool({
    description:
      "Hand a self-contained sub-task to a fresh sub-agent that runs on the model best suited and cheapest for it (auto-routed across your providers), with full file tools in this same repo. Use it to offload a bounded chunk — a focused refactor, bulk edits, reading/research, code generation — so you stay the orchestrator while a cheaper/faster/specialist model does the legwork. Set `role` to shape it: 'explore' (read-only research, returns findings), 'review' (read-only critique on a DIFFERENT model family than yours — catches what a same-family model rationalizes), or 'code' (implement; the default). The sub-agent does NOT see this conversation, so make `task` completely self-contained. It runs to completion and returns a report.",
    inputSchema: z.object({
      task: z.string().describe("The complete, self-contained sub-task: what to do, which files, constraints, definition of done."),
      role: ROLE.optional().describe("explore = read-only research; review = read-only cross-family critique; code = implement (default). Picks the model + tool posture for the sub-task."),
      kind: KIND.optional().describe("Optional task-kind hint to steer model routing (inferred if omitted; a role sets it)."),
      background: z.boolean().optional().describe("true = don't wait: keep working while the sub-agent runs; its report arrives in the conversation when it finishes. Use for research/long tasks whose result you don't need THIS turn."),
    }),
    execute: async ({ task, role, kind, background }) => {
      // GUARD 1 (whole-task): refuse to offload essentially the entire turn to a
      // single sub-agent — that's pure overhead + context loss, and it's how a
      // "Sonnet delegates the whole task to Sonnet" pathology happens.
      if (orchestratorPrompt && isWholeTask(task, orchestratorPrompt)) {
        return "Not delegating: that is essentially this whole task. Do it yourself, or split it into smaller, bounded sub-tasks (one file or area each) and delegate those — delegation is for offloading a CHUNK, not the entire turn.";
      }
      // A role contributes its routing signals: kind (sets the bar) and, for a
      // cross-family review, excludeFamily computed against the orchestrator's own
      // model (the "author") so the reviewer lands on a different vendor.
      const roleSpec = role ? roleByName(role) : undefined;
      const roleSig = roleSpec ? roleRoutingSignals(roleSpec, orchestratorModelId) : {};
      const reroute = () => routeSubTask(task, roleSig.kind ?? kind, opts.pinnedModelId, opts.root, { excludeFamily: roleSig.excludeFamily });
      const routed = reroute();
      if ("error" in routed) return `delegation skipped: ${routed.error}. Do it yourself.`;
      // GUARD 2 (same-model, size-gated): a SEQUENTIAL delegate to your own model
      // has no cheaper-model or concurrency payoff — only CONTEXT ISOLATION. That
      // pays off for a SUBSTANTIAL sub-task (a fresh focused window, as mature
      // harnesses use subagents) but not a tiny one, which is strictly cheaper
      // inline. So refuse same-model ONLY when the work is small; allow it when
      // it's sizable. A read-only role (explore/review) is ALSO exempt — isolating
      // research/critique into a clean read-only context is the whole point, even
      // on the same model. Background and delegate_parallel are exempt too (the
      // benefit there is concurrency). Compare CANONICALLY: a sub-task can route to
      // the same model via a seat/alias whose spec id differs from the
      // orchestrator's; the orchestrator runs in-loop so its id is canonical.
      const sameModel = !background && !roleSpec?.readOnly && orchestratorModelId && !routed.cli && (routed.canonicalId ?? routed.model.id) === orchestratorModelId;
      if (sameModel && !sameModelDelegateWorthIt(deriveSubTaskSignals(task, opts.root))) {
        return `Not delegating: that routes to ${routed.model.label} — the same model you're already running, and the sub-task is small enough that a sequential delegate just adds latency and loses context. Do it inline. (Delegate when a cheaper/faster/specialist model fits, when the chunk is large enough that an isolated context helps, set role:'review' for a cross-family critique, or use delegate_parallel / background:true for concurrency.)`;
      }
      // Background mode: fire-and-continue. The live activity line still
      // streams (the rail shows it running); the report is delivered to the
      // conversation by the host when it settles.
      if (background && onBackground) {
        const bgNum = ++counter;
        const bgId = `delegate-${bgNum}`;
        onEvent({ type: "tool-start", id: bgId, name: "delegate", arg: `#bg${bgNum} (background) → ${routed.model.label} · ${clipTask(task, 60)}` });
        void runOne(run, routed, task, { signal, runCli, role: roleSpec, reroute, onActivity: (line) => onEvent({ type: "tool-stream", id: bgId, activity: line }) })
          .then((res) => {
            onEvent({ type: "tool-end", id: bgId, ok: res.ok, summary: reportLine(res.text) || routed.model.label });
            onBackground({ id: bgNum, task, ok: res.ok, text: res.text });
          })
          .catch((e: any) => {
            onEvent({ type: "tool-end", id: bgId, ok: false, summary: "crashed" });
            onBackground({ id: bgNum, task, ok: false, text: `crashed: ${e?.message ?? e}` });
          });
        return `Sub-task #bg${bgNum} is running in the BACKGROUND on ${routed.model.label}. Its report will arrive in the conversation when it finishes — do not wait for it; continue with other work now.`;
      }
      const id = `delegate-${++counter}`;
      onEvent({ type: "tool-start", id, name: "delegate", arg: `→ ${routed.model.label}${routed.cli ? " (subscription)" : ""} · ${clipTask(task, 72)}` });
      let res: { ok: boolean; text: string };
      try {
        // Sequential: runs in the main workspace. Live progress is streamed as
        // a single replacing "activity" line via onActivity.
        res = await runOne(run, routed, task, { signal, runCli, role: roleSpec, reroute, onActivity: (line) => onEvent({ type: "tool-stream", id, activity: line }) });
      } catch (e: any) {
        onEvent({ type: "tool-end", id, ok: false, summary: `${routed.model.label} · crashed` });
        return `sub-agent (${routed.model.label}) crashed: ${e?.message ?? e}`;
      }
      onEvent({ type: "tool-end", id, ok: res.ok, summary: reportLine(res.text) || routed.model.label });
      return res.text;
    },
  });

  // ── delegate_parallel (concurrent fan-out, git worktree isolation) ───────────
  const delegate_parallel = tool({
    description:
      "Run SEVERAL sub-tasks, each on its own best-routed model AND its own isolated git worktree (seeded with your current edits), so their writes can't collide. Use for 2+ chunks (e.g. 'add tests to A', 'document B', 'refactor C'). Independent chunks run concurrently; declare `after` to ORDER dependent ones (a task waits for the tasks it lists, and its worktree is re-seeded with their merged results), and two chunks touching the SAME file are auto-scheduled into different waves so they never collide. Each sub-task is self-contained (sub-agents don't see this conversation or each other). Changes merge back after each wave (a file touched by several in one wave is 3-way auto-merged; only truly-overlapping edits leave conflict markers). Requires a git repo. For tightly-coupled work, use `delegate` one at a time.",
    inputSchema: z.object({
      tasks: z.array(z.object({
        task: z.string().describe("A complete, self-contained sub-task. Name the files it touches so conflicts schedule correctly."),
        role: ROLE.optional().describe("explore = read-only research; review = read-only cross-family critique; code = implement (default)."),
        kind: KIND.optional(),
        after: z.array(z.number().int().min(1)).optional().describe("1-based task numbers this one depends on (must finish first). Its worktree is re-seeded with their results, so it sees their edits. Omit for independent tasks."),
      })).min(2).max(6).describe("2-6 sub-tasks; independent ones run concurrently, `after` orders the rest."),
    }),
    execute: async ({ tasks }) => {
      const repoRoot = gitToplevel(opts.root);
      if (!repoRoot) return "parallel delegation needs a git repo (it isolates each sub-agent in a worktree). Use `delegate` one task at a time instead.";
      const batch = ++counter;
      const groupId = `delegate_parallel-${batch}`;

      // Resolve route + role + conflict signals per task (no worktree yet). The
      // touched-file set (sniffed from the task text) and `after` deps feed the
      // pure planner, which lays the tasks into safe-to-run-concurrently waves.
      type Spec = { idx: number; task: string; role?: RoleSpec; reroute: () => Routed | { error: string }; routed?: Routed; files: string[]; after: number[]; error?: string };
      const specs: Spec[] = tasks.map((t, idx) => {
        const role = t.role ? roleByName(t.role) : undefined;
        const roleSig = role ? roleRoutingSignals(role, orchestratorModelId) : {};
        const reroute = () => routeSubTask(t.task, roleSig.kind ?? t.kind, opts.pinnedModelId, opts.root, { excludeFamily: roleSig.excludeFamily });
        const routed = reroute();
        const files = parseTouchedFiles(t.task).map((f) => f.toLowerCase());
        const after = (t.after ?? []).map((a) => a - 1); // 1-based → 0-based
        const base = { idx, task: t.task, role, reroute, files, after };
        return "error" in routed ? { ...base, error: routed.error } : { ...base, routed };
      });
      const waves = partitionIntoWaves(specs.map((s) => ({ files: s.files, after: s.after })));
      onEvent({ type: "tool-start", id: groupId, name: "delegate_parallel", arg: `${tasks.length} sub-tasks${waves.length > 1 ? ` · ${waves.length} waves` : " in parallel"}` });

      const skipped: string[] = [];
      const results: { spec: Spec; res: { ok: boolean; text: string }; changed: { path: string; deleted: boolean }[] }[] = [];
      let applied = 0, autoMerged = 0;
      const conflicted: string[] = [];
      const created: string[] = []; // every worktree, for the outer-finally safety sweep

      try {
        for (const wave of waves) {
          // Build this wave's runnable jobs. Worktrees are created NOW (after any
          // prior wave merged into repoRoot), so a dependent task is seeded with
          // its dependencies' results. Routing errors become skips, not aborts.
          const jobs: { spec: Spec; routed: Routed; dir: string }[] = [];
          for (const i of wave) {
            const s = specs[i]!;
            if (s.error || !s.routed) { skipped.push(`#${s.idx + 1}: ${s.error ?? "no model"}`); continue; }
            const dir = join(tmpdir(), `gearbox-fanout-${batch}-${s.idx}-${Date.now()}`);
            if (!addSeededWorktree(repoRoot, dir)) { skipped.push(`#${s.idx + 1}: couldn't create a worktree`); continue; }
            created.push(dir);
            jobs.push({ spec: s, routed: s.routed, dir });
          }
          if (!jobs.length) continue;

          // Run this wave concurrently — every job is conflict-free with the rest
          // of its wave by construction. Differentiate near-identical labels.
          const waveTasks = jobs.map((x) => x.spec.task);
          const outcomes = await Promise.all(jobs.map(async (j, ji) => {
            const jid = `${groupId}:${j.spec.idx}`;
            onEvent({ type: "tool-start", id: jid, name: "delegate", arg: `#${j.spec.idx + 1} → ${j.routed.model.label}${j.routed.cli ? " (subscription)" : ""} · ${differentiatingSlice(waveTasks, ji, 56)}` });
            let res: { ok: boolean; text: string };
            try { res = await runOne(run, j.routed, j.spec.task, { signal, root: j.dir, runCli, role: j.spec.role, reroute: j.spec.reroute, onActivity: (line) => onEvent({ type: "tool-stream", id: jid, activity: line }) }); }
            catch (e: any) { res = { ok: false, text: `crashed: ${e?.message ?? e}` }; }
            onEvent({ type: "tool-end", id: jid, ok: res.ok, summary: reportLine(res.text) || j.routed.model.label });
            return { j, res, changed: res.ok ? changesIn(j.dir, true) : [] };
          }));

          // Merge this wave back into repoRoot before the next wave starts, so the
          // next wave's worktrees seed from the merged state.
          const writers = new Map<string, { dir: string; deleted: boolean }[]>();
          for (const o of outcomes) for (const c of o.changed) {
            writers.set(c.path, [...(writers.get(c.path) ?? []), { dir: o.j.dir, deleted: c.deleted }]);
          }
          for (const [path, who] of writers) {
            const dst = join(repoRoot, path);
            const existed = existsSync(dst);
            const before = existed ? (() => { try { return readFileSync(dst, "utf8"); } catch { return ""; } })() : "";
            if (who.length === 1) {
              const w = who[0]!;
              try {
                if (w.deleted) { if (existed) rmSync(dst, { force: true }); }
                else { mkdirSync(dirname(dst), { recursive: true }); copyFileSync(join(w.dir, path), dst); }
                applied++;
              } catch { continue; }
            } else {
              const hadMarkers = mergeFileBack(repoRoot, path, who.filter((w) => !w.deleted).map((w) => w.dir));
              autoMerged++;
              if (hadMarkers) conflicted.push(path);
            }
            onEvent({ type: "file-change", path: relative(opts.root ?? process.cwd(), dst), before, existed });
          }
          for (const o of outcomes) results.push({ spec: o.j.spec, res: o.res, changed: o.changed });
          // Drop this wave's worktrees now so the next wave re-seeds from the
          // merged tree (and stale registrations don't accumulate).
          for (const j of jobs) removeWorktree(repoRoot, j.dir);
        }

        // Assemble the tool result. Report in task order, not wave order.
        results.sort((a, b) => a.spec.idx - b.spec.idx);
        const lines = results.map((o) => `#${o.spec.idx + 1} (${o.spec.routed!.model.label}): ${subAgentDigest(o.res.text, o.changed)}`);
        const ran = results.length;
        const waveNote = waves.length > 1 ? ` across ${waves.length} waves` : " in parallel";
        const parts = [`Ran ${ran} sub-task(s)${waveNote} · applied ${applied} file change(s)${autoMerged ? `, 3-way-merged ${autoMerged} shared file(s)` : ""}.`];
        if (conflicted.length) parts.push(`Conflict markers left in (resolve these): ${conflicted.join(", ")}.`);
        if (skipped.length) parts.push(`Skipped: ${skipped.join("; ")}.`);
        onEvent({ type: "tool-end", id: groupId, ok: true, summary: `${ran} done · ${applied + autoMerged} merged${conflicted.length ? ` · ${conflicted.length} w/ markers` : ""}` });
        return [parts.join(" "), "", ...lines].join("\n");
      } finally {
        // Safety sweep: remove any worktree not already cleaned (e.g. an abort
        // mid-wave), so stale git worktree registrations never accumulate.
        for (const dir of created) removeWorktree(repoRoot, dir);
      }
    },
  });

  // ── spawn_subagent / collect_subagents (async fan-out: fire many, keep
  // working, collect when you need them) ───────────────────────────────────────
  // Unlike delegate_parallel (which BLOCKS until all finish), spawn returns
  // immediately so the orchestrator can fire many sub-agents AND keep doing its
  // own work; collect gathers the finished ones (optionally waiting). Each spawn
  // runs in its own git worktree (when in a repo) so concurrent writes are
  // isolated and merged back on collect; in a non-repo, sub-agents run in the
  // main workspace (fine for read/research fan-out).
  type SpawnJob = {
    num: number;
    task: string;
    label: string;
    dir?: string; // worktree (git repo) or undefined (main workspace)
    settled?: { ok: boolean; text: string; changed: { path: string; deleted: boolean }[] };
    promise: Promise<{ ok: boolean; text: string; changed: { path: string; deleted: boolean }[] }>;
  };
  const spawned: SpawnJob[] = [];
  const collectedNums = new Set<number>();
  // Turn-end teardown (review #8): spawn_subagent creates a worktree per job, but
  // cleanup otherwise lives only in collect_subagents — so a turn that spawns and
  // ends without collecting (model forgets, errors, or the user aborts) would
  // orphan the temp dirs + git worktree registrations. run.ts calls this in a
  // finally to sweep any uncollected ones.
  if (opts.spawnCleanup) opts.spawnCleanup.current = () => {
    const root = gitToplevel();
    for (const j of spawned) if (!collectedNums.has(j.num) && j.dir && root) { collectedNums.add(j.num); removeWorktree(root, j.dir); }
  };
  // Concurrency cap so 20-30 spawns don't open 20-30 model streams at once.
  const SPAWN_CAP = 8;
  let runningSpawns = 0;
  const slotQueue: (() => void)[] = [];
  const withSlot = async <T,>(fn: () => Promise<T>): Promise<T> => {
    if (runningSpawns >= SPAWN_CAP) await new Promise<void>((r) => slotQueue.push(r));
    runningSpawns++;
    try { return await fn(); }
    finally { runningSpawns--; slotQueue.shift()?.(); }
  };

  const spawn_subagent = tool({
    description:
      "Fire a sub-task to a fresh, best-routed sub-agent and KEEP WORKING — it runs in the background (in its own isolated git worktree when in a repo) and returns a job id immediately. Call it many times to fan out (research several files at once, generate several modules, etc.), then `collect_subagents` to gather the results when you need them. Use this instead of `delegate` when you have independent work to do WHILE the sub-agents run; use `delegate_parallel` when you just want to block until a small fixed batch finishes. Make each `task` completely self-contained (the sub-agent does not see this conversation).",
    inputSchema: z.object({
      task: z.string().describe("The complete, self-contained sub-task: what to do, which files, constraints, definition of done."),
      role: ROLE.optional().describe("explore = read-only research; review = read-only cross-family critique; code = implement (default)."),
      kind: KIND.optional().describe("Optional task-kind hint to steer model routing (inferred if omitted; a role sets it)."),
    }),
    execute: async ({ task, role, kind }) => {
      if (orchestratorPrompt && isWholeTask(task, orchestratorPrompt)) {
        return "Not spawning: that is essentially this whole task. Split it into smaller, independent sub-tasks and spawn those.";
      }
      const roleSpec = role ? roleByName(role) : undefined;
      const roleSig = roleSpec ? roleRoutingSignals(roleSpec, orchestratorModelId) : {};
      const reroute = () => routeSubTask(task, roleSig.kind ?? kind, opts.pinnedModelId, opts.root, { excludeFamily: roleSig.excludeFamily });
      const routed = reroute();
      if ("error" in routed) return `spawn skipped: ${routed.error}. Do it yourself.`;
      const num = ++counter;
      const repoRoot = gitToplevel();
      let dir: string | undefined;
      if (repoRoot) {
        const d = join(tmpdir(), `gearbox-spawn-${num}-${Date.now()}`);
        if (addSeededWorktree(repoRoot, d)) dir = d;
      }
      const jid = `spawn-${num}`;
      onEvent({ type: "tool-start", id: jid, name: "spawn_subagent", arg: `#${num} → ${routed.model.label}${routed.cli ? " (subscription)" : ""} · ${clipTask(task, 60)}` });
      // The job promise NEVER rejects — every failure (the sub-agent, OR the git
      // staging in changesIn, which runs outside runOne's try) degrades to a
      // per-job error so one bad spawn can't blow up collect_subagents (review #9).
      const promise = withSlot(async () => {
        let res: { ok: boolean; text: string };
        try { res = await runOne(run, routed, task, { signal, root: dir, runCli, role: roleSpec, reroute, onActivity: (line) => onEvent({ type: "tool-stream", id: jid, activity: line }) }); }
        catch (e: any) { res = { ok: false, text: `crashed: ${e?.message ?? e}` }; }
        let changed: { path: string; deleted: boolean }[] = [];
        try { if (res.ok && dir) changed = changesIn(dir, true); } catch { /* git staging error → no merge, keep the report */ }
        onEvent({ type: "tool-end", id: jid, ok: res.ok, summary: reportLine(res.text) || routed.model.label });
        return { ...res, changed };
      });
      const job: SpawnJob = { num, task, label: routed.model.label, dir, promise };
      job.promise.then((s) => { job.settled = s; }).catch(() => {});
      spawned.push(job);
      return `Spawned sub-task #${num} on ${routed.model.label} (running in the background). Keep working; call collect_subagents when you need its result. ${spawned.filter((j) => !collectedNums.has(j.num)).length} sub-task(s) outstanding.`;
    },
  });

  const collect_subagents = tool({
    description:
      "Gather results from sub-agents started with spawn_subagent. By default it WAITS for all still-running spawned sub-tasks and returns their reports (merging each one's file changes back into your workspace). Set wait:false to grab only the ones that have already finished without blocking. Call this once you've run out of other work to do, or whenever you need a spawned result to continue.",
    inputSchema: z.object({
      wait: z.boolean().optional().describe("true (default) = wait for all outstanding spawned sub-tasks; false = return only the ones already finished."),
    }),
    execute: async ({ wait = true }) => {
      const outstanding = spawned.filter((j) => !collectedNums.has(j.num));
      if (!outstanding.length) return "No spawned sub-tasks to collect.";
      const ready = wait ? outstanding : outstanding.filter((j) => j.settled);
      if (!ready.length) return `Nothing finished yet (${outstanding.length} still running). Keep working, or call collect_subagents with wait:true.`;
      const results = await Promise.all(ready.map(async (j) => ({ j, s: j.settled ?? (await j.promise) })));
      const repoRoot = gitToplevel();
      // Merge each finished worktree back (reuse the same per-file apply/3-way
      // logic as delegate_parallel), then clean the worktree up.
      const writers = new Map<string, { dir: string; deleted: boolean }[]>();
      if (repoRoot) for (const { j, s } of results) if (j.dir) for (const c of s.changed) writers.set(c.path, [...(writers.get(c.path) ?? []), { dir: j.dir, deleted: c.deleted }]);
      let applied = 0, autoMerged = 0;
      const conflicted: string[] = [];
      if (repoRoot) for (const [path, who] of writers) {
        const dst = join(repoRoot, path);
        const existed = existsSync(dst);
        const before = existed ? (() => { try { return readFileSync(dst, "utf8"); } catch { return ""; } })() : "";
        if (who.length === 1) {
          const w = who[0]!;
          try { if (w.deleted) { if (existed) rmSync(dst, { force: true }); } else { mkdirSync(dirname(dst), { recursive: true }); copyFileSync(join(w.dir, path), dst); } applied++; } catch { continue; }
        } else {
          if (mergeFileBack(repoRoot, path, who.filter((w) => !w.deleted).map((w) => w.dir))) conflicted.push(path);
          autoMerged++;
        }
        onEvent({ type: "file-change", path: relative(process.cwd(), dst), before, existed });
      }
      for (const { j } of results) { collectedNums.add(j.num); if (repoRoot && j.dir) removeWorktree(repoRoot, j.dir); }
      const remaining = spawned.filter((x) => !collectedNums.has(x.num)).length;
      const lines = results.map(({ j, s }) => `#${j.num} (${j.label}): ${subAgentDigest(s.text, s.changed)}`);
      const head = `Collected ${results.length} sub-task(s)${applied || autoMerged ? ` · applied ${applied}${autoMerged ? `, 3-way-merged ${autoMerged}` : ""} file change(s)` : ""}${conflicted.length ? ` · conflict markers in ${conflicted.join(", ")}` : ""}${remaining ? ` · ${remaining} still outstanding` : ""}.`;
      return [head, "", ...lines].join("\n");
    },
  });

  return { delegate, delegate_parallel, spawn_subagent, collect_subagents };
}
