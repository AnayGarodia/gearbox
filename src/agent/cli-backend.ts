// CLI-backed execution: drive the official `claude` / `codex` binary as a
// subprocess and map its stream-json output to our AgentEvent stream. This is
// the ToS-clean way to use a Pro/Max/Plus SUBSCRIPTION (the token never leaves
// the vendor binary — we don't read it). Conductor does the same thing.
//
// IMPORTANT: the CLI runs ITS OWN agent loop, tools, and permission gate —
// Gearbox's permission.ts / tools.ts / context engine do NOT apply here. We
// surface that in the UI. Cross-binary hand-off carries plain-text transcript
// only (tool history doesn't translate), so we append the user prompt + the
// assistant's final text to the ledger and move on.
//
// Event schemas recorded in experiments/cli-backend-spike.md.
import type { ModelMessage } from "ai";
import type { OnEvent, Usage } from "./events.ts";
import { spawnProc } from "../proc.ts";
import { readFileSync, statSync, mkdirSync } from "node:fs";
import { join, dirname, resolve as resolvePath } from "node:path";
import type { Proc } from "../proc.ts";
import { defaultReadRoots } from "../tools.ts";
import { requestPermission, type PermKind } from "../permission.ts";
import { tmpdir } from "node:os";

/**
 * Map a Claude Code tool name + input to a gearbox permission request. Headless
 * `claude -p` can't show its own approval UI, so when the interactive bridge is
 * active (see runCliTask) each `can_use_tool` control request is translated to
 * one of gearbox's three kinds and routed through requestPermission — the SAME
 * in-TUI prompt the in-loop tools use, so "always"/yolo grants are shared.
 */
function cliToolPermission(name: string, input: any, description?: string): { kind: PermKind; title: string; detail: string } {
  const n = (name || "").toLowerCase();
  const path = input?.file_path ?? input?.path ?? input?.notebook_path;
  if (n === "bash") return { kind: "shell", title: "Run a shell command", detail: String(input?.command ?? description ?? name) };
  if (n === "write") return { kind: "write", title: "Create or overwrite a file", detail: String(path ?? description ?? name) };
  if (n.includes("edit") || n === "update" || n === "notebookedit") return { kind: "edit", title: "Edit a file", detail: String(path ?? description ?? name) };
  // Anything else that still asked (rare under acceptEdits + the allowlist):
  // gate behind the shell kind so it can't run silently.
  return { kind: "shell", title: `Use ${name}`, detail: String(description ?? path ?? name) };
}

/** Pre-approved out-of-repo scratch space for headless CLI seats (worktrees,
 *  temp files). Exported so prompt builders can name it to the agent. */
export function cliScratchDir(): string {
  return join(tmpdir(), "gearbox-scratch");
}

export interface CliRate {
  utilization?: number; // 0..1, ONLY when the CLI reports a number (it often doesn't)
  status?: string; // the CLI's own word: "allowed" / "allowed_warning" / "rejected"
  resetsAt?: number;
  type?: string;
}

export interface CliResult {
  messages: ModelMessage[];
  usage: Usage;
  sessionId?: string; // the binary's own session id, for resume
  costUSD?: number; // claude reports this; codex doesn't
  model?: string; // the model the CLI actually used (from its stream) — for the status bar
  rates?: CliRate[]; // claude's rate_limit_events — ONE per window (5-hour, 7-day)
  failure?: { message: string }; // set when the turn errored (for failover); the caller decides whether to show it
}

// Accumulates across a stream so runCliTask can build the result.
interface CliState {
  text: string;
  usage: Usage;
  sessionId?: string;
  costUSD?: number;
  model?: string; // the model id reported by the CLI stream (claude: init/assistant)
  // Keyed by window type so a 5-hour and a 7-day event don't overwrite each
  // other (claude emits them as separate rate_limit_events).
  rates: Map<string, CliRate>;
  toolNames: Map<string, string>;
}

function newState(): CliState {
  return { text: "", usage: { inputTokens: 0, outputTokens: 0 }, rates: new Map(), toolNames: new Map() };
}

// Map ONE parsed NDJSON object to AgentEvents + fold into state. Pure (no IO) so
// it's unit-testable against recorded fixtures. Returns nothing; mutates state.
function mapCliEvent(binary: string, obj: any, state: CliState, onEvent: OnEvent): void {
  const isCodex = binary.includes("codex");
  if (isCodex) {
    switch (obj?.type) {
      case "thread.started":
        state.sessionId = obj.thread_id;
        break;
      case "item.completed": {
        const item = obj.item ?? {};
        if (item.type === "agent_message" && item.text) {
          state.text += item.text;
          onEvent({ type: "text", text: item.text });
        } else if (item.type === "error") {
          onEvent({ type: "error", message: String(item.message ?? "error") });
        } else if (item.type && item.id) {
          // command_execution / file_change / mcp_tool_call etc. — coarse mapping
          // (no streamed tool input from the CLI).
          onEvent({ type: "tool-start", id: item.id, name: item.type, arg: shortArg(item) });
          onEvent({ type: "tool-end", id: item.id, ok: item.status !== "failed" && item.status !== "error", summary: shortArg(item) });
        }
        break;
      }
      case "turn.completed":
        // Only overwrite with numbers the event actually carries — a final
        // event with no usage must not clobber counts already accumulated.
        if (obj.usage) {
          state.usage.inputTokens = obj.usage.input_tokens ?? state.usage.inputTokens;
          state.usage.outputTokens = obj.usage.output_tokens ?? state.usage.outputTokens;
        }
        break;
    }
    return;
  }

  // claude
  switch (obj?.type) {
    case "system":
      if (obj.subtype === "init" && obj.session_id) state.sessionId = obj.session_id;
      if (obj.subtype === "init" && obj.model) state.model = obj.model; // the model this session will use
      break; // hook_* noise ignored
    case "rate_limit_event": {
      // claude reports each window (five_hour, seven_day, …) in its own event;
      // key by type so they accumulate instead of overwriting.
      // The print-mode event carries utilization ONLY near a limit (else just a
      // status word). The exact-anytime % comes from the usage probe instead
      // (src/accounts/usage-probe.ts); here we capture whatever the stream gives.
      const ri = obj.rate_limit_info ?? obj; // some CLI versions flatten onto the event itself
      if (ri) {
        const type = ri.rateLimitType ?? ri.type ?? ri.windowType ?? "limit";
        const utilization = typeof ri.utilization === "number" ? ri.utilization
          : typeof ri.usageFraction === "number" ? ri.usageFraction
          : typeof ri.usage_fraction === "number" ? ri.usage_fraction
          : undefined;
        state.rates.set(type, { utilization, status: ri.status, resetsAt: ri.resetsAt ?? ri.resets_at, type });
      }
      break;
    }
    case "assistant": {
      if (obj.message?.model) state.model = obj.message.model; // the model that produced this message
      // Per-message usage accumulates as the stream runs so a subprocess that
      // dies before its final `result` event (which carries the authoritative
      // totals and overwrites these) still reports the tokens it streamed,
      // instead of emitting `done` with zero usage.
      const mu = obj.message?.usage;
      if (mu) {
        state.usage.inputTokens += mu.input_tokens ?? 0;
        state.usage.outputTokens += mu.output_tokens ?? 0;
      }
      for (const part of obj.message?.content ?? []) {
        if (part.type === "text" && part.text) {
          state.text += part.text;
          onEvent({ type: "text", text: part.text });
        } else if (part.type === "tool_use" && part.name === "AskUserQuestion") {
          // The subscription CLI's interactive question tool. Gearbox drives the
          // CLI in print mode, so it can't render the CLI's own picker or feed an
          // answer back into this turn. Surface the question + options as readable
          // text instead of a truncated, empty-looking tool call, so the user can
          // see what's being asked and answer in their next message.
          const q = formatAskUserQuestion(part.input);
          if (q) onEvent({ type: "text", text: q });
        } else if (part.type === "tool_use") {
          state.toolNames.set(part.id, part.name);
          onEvent({ type: "tool-start", id: part.id, name: part.name ?? "tool", arg: shortArg(part.input) });
        }
      }
      break;
    }
    case "user": {
      for (const part of obj.message?.content ?? []) {
        if (part.type === "tool_result") {
          onEvent({ type: "tool-end", id: part.tool_use_id, ok: !part.is_error, summary: state.toolNames.get(part.tool_use_id) ?? "done" });
        }
      }
      break;
    }
    case "result": {
      // Authoritative turn totals — overwrite the streamed accumulation, but
      // never clobber it with zero when a field is missing.
      const u = obj.usage ?? {};
      state.usage.inputTokens = u.input_tokens ?? state.usage.inputTokens;
      state.usage.outputTokens = u.output_tokens ?? state.usage.outputTokens;
      if (typeof obj.total_cost_usd === "number") state.costUSD = obj.total_cost_usd;
      if (obj.session_id) state.sessionId = obj.session_id;
      // `result` text is the final answer; if no streamed assistant text arrived
      // (rare), surface it now.
      if (!state.text && typeof obj.result === "string" && !obj.is_error) {
        state.text = obj.result;
        onEvent({ type: "text", text: obj.result });
      }
      if (obj.is_error) onEvent({ type: "error", message: String(obj.result ?? "the CLI returned an error") });
      break;
    }
  }
}

// Relativize a workspace path BEFORE clipping, so a long absolute path keeps its
// meaningful tail (the filename) instead of being cut mid-path at the 64-char cap.
function relWorkspace(s: string): string {
  const cwd = process.cwd();
  return s.startsWith(cwd + "/") ? s.slice(cwd.length + 1) : s;
}
function shortArg(x: any): string {
  if (x == null) return "";
  if (typeof x === "string") return relWorkspace(x).slice(0, 64);
  const s = x.command ?? x.path ?? x.file_path ?? x.cmd ?? "";
  return relWorkspace(String(s)).slice(0, 64);
}

// Render an AskUserQuestion tool input (one or more questions, each with labeled
// options) as readable markdown, so a question the CLI would normally ask through
// its own picker is visible in the transcript and answerable in the next message.
export function formatAskUserQuestion(input: any): string {
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  if (!questions.length) return "";
  const blocks = questions.map((q: any) => {
    const head = String(q?.question ?? q?.header ?? "Question");
    const options = Array.isArray(q?.options) ? q.options : [];
    const lines = options.map(
      (o: any, i: number) =>
        `${i + 1}. **${String(o?.label ?? "")}**${o?.description ? ` — ${String(o.description)}` : ""}`,
    );
    return [`**${head}**`, ...lines].join("\n");
  });
  return blocks.join("\n\n") + "\n\n_Reply with your choice to continue._";
}

// CRITICAL: the vendor CLIs prefer an API key in the environment over their
// subscription OAuth login. If ANTHROPIC_API_KEY / OPENAI_API_KEY is set (e.g.
// imported as a Gearbox account), claude/codex would bill the API — not the
// Pro/Max/Plus subscription — and fail if that key is out of credits. So we run
// the subprocess with the provider's API-key vars stripped, forcing it onto the
// subscription login. (We don't touch the keys for in-loop API accounts.)
const KEYS_TO_STRIP: Record<string, string[]> = {
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
  codex: ["OPENAI_API_KEY"],
};
// The env var each CLI uses to relocate its config + credentials — the mechanism
// for MULTIPLE accounts of the same kind: each account points at its own dir, so
// several claude (or codex) logins coexist instead of sharing one system login.
const CONFIG_DIR_VAR: Record<string, string> = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" };

export function subscriptionEnv(binary: string, profile?: string, oauthToken?: string): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const k of KEYS_TO_STRIP[binary] ?? []) delete env[k];
  if (profile && CONFIG_DIR_VAR[binary]) env[CONFIG_DIR_VAR[binary]!] = profile;
  // A stored 1-year setup token (claude) rides as CLAUDE_CODE_OAUTH_TOKEN — it
  // outranks the keychain login, never rotates, and is immune to the macOS
  // shared-keychain collision between accounts (claude-code issue #20553).
  if (oauthToken && binary.includes("claude")) env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  else delete env.CLAUDE_CODE_OAUTH_TOKEN; // never inherit another account's token
  return env;
}

/** Build the binary's argv. Flags are best-effort per the spike; may need
 *  per-version tuning. `autoApprove` mirrors Gearbox's yolo (the CLI self-governs). */
function cliModelArg(binary: string, modelId?: string): string | undefined {
  if (!modelId) return undefined;
  if (binary.includes("claude")) {
    // Pass full ids straight through — `claude --model` accepts a model's full
    // name (e.g. "claude-opus-4-8"), and the family alias ("opus") lets the CLI
    // substitute its own default version, breaking the routed-model promise.
    if (modelId.startsWith("claude-")) return modelId;
    if (modelId.includes("opus")) return "opus";
    if (modelId.includes("sonnet")) return "sonnet";
    if (modelId.includes("haiku")) return "haiku";
  }
  return modelId;
}

/** In a git WORKTREE the real git dir lives OUTSIDE the workspace (.git here is
 *  a pointer file: "gitdir: <main>/.git/worktrees/<name>"). Codex's
 *  workspace-write sandbox therefore blocks every git mutation (branch/commit/
 *  push all write through that pointer) — the exact "permissions are never
 *  there in worktrees" failure. Resolve the main .git dir so it can be added
 *  to the sandbox's writable roots. Returns [] for a normal repo (its .git is
 *  a directory inside the workspace) or a non-repo. */
export function worktreeGitRoots(cwd: string): string[] {
  try {
    const dotGit = join(cwd, ".git");
    if (!statSync(dotGit).isFile()) return [];
    const m = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)\s*$/m);
    if (!m) return [];
    const gitdir = resolvePath(cwd, m[1]!.trim()); // <main>/.git/worktrees/<name>
    const mainGit = dirname(dirname(gitdir)); // <main>/.git
    return [mainGit];
  } catch {
    return [];
  }
}

/** Render the conversation ledger as a compact plain-text transcript for a
 *  FRESH vendor-CLI session (a seat switch: codex hit its limit → claude takes
 *  over). The vendor binary keeps its own history per session, so without this
 *  the new seat starts with ZERO context — the ledger gearbox carried across
 *  the whole conversation never reached it. Tool exchanges don't translate
 *  across binaries; text does. Newest turns win the budget (taken from the
 *  end), each message clipped so one giant paste can't evict the rest. */
export function handoffDigest(messages: ModelMessage[], maxChars = 12_000): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const c = (m as any).content;
    const text = typeof c === "string"
      ? c
      : Array.isArray(c) ? c.map((p: any) => (typeof p === "string" ? p : p?.type === "text" ? p.text ?? "" : "")).join(" ") : "";
    const t = text.trim();
    if (!t) continue;
    const clipped = t.length > 1_200 ? t.slice(0, 1_200) + " …[clipped]" : t;
    parts.push(`${m.role === "user" ? "User" : "Assistant"}: ${clipped}`);
  }
  if (!parts.length) return "";
  const kept: string[] = [];
  let used = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    const cost = parts[i]!.length + 1;
    if (used + cost > maxChars && kept.length) break;
    kept.unshift(parts[i]!);
    used += cost;
  }
  const dropped = parts.length - kept.length;
  return (
    `<conversation-so-far>\n` +
    (dropped ? `[${dropped} earlier message${dropped === 1 ? "" : "s"} elided]\n` : "") +
    kept.join("\n") +
    `\n</conversation-so-far>\n` +
    `The conversation above happened in THIS session on a different model/account — continue it; do not start over or re-ask answered questions.`
  );
}

export function buildCliArgs(binary: string, prompt: string, opts: { sessionId?: string; autoApprove?: boolean; readOnly?: boolean; modelId?: string; effort?: string; writableRoots?: string[]; addDirs?: string[]; repoRoot?: string; bridge?: boolean } = {}): string[] {
  const model = cliModelArg(binary, opts.modelId);
  if (binary.includes("codex")) {
    // Auth still comes from CODEX_HOME, but user config can contain hooks/MCP
    // settings that are stale or unsafe for this subprocess. Keep Gearbox's
    // subscription bridge clean and let the Codex CLI own the actual turn.
    const flags: string[] = ["--json", "--skip-git-repo-check", "--ignore-user-config"];
    // `codex exec resume` accepts ONLY --json/--skip-git-repo-check/
    // --ignore-user-config/--config — passing --sandbox/--model there is a
    // hard CLI error ("unexpected argument '--sandbox'"). Express model,
    // effort, and sandbox/approval as -c config overrides, which BOTH
    // subcommands accept, and keep the flag spellings for fresh `exec` only.
    const resume = Boolean(opts.sessionId);
    if (model) {
      if (resume) flags.push("-c", `model="${model}"`);
      else flags.push("--model", model);
    }
    if (opts.effort) flags.push("-c", `model_reasoning_effort="${opts.effort}"`);
    if (opts.readOnly) flags.push(...(resume ? ["-c", `sandbox_mode="read-only"`] : ["--sandbox", "read-only"]), "-c", `approval_policy="never"`);
    else if (opts.autoApprove) {
      if (resume) flags.push("-c", `sandbox_mode="danger-full-access"`, "-c", `approval_policy="never"`);
      else flags.push("--dangerously-bypass-approvals-and-sandbox");
    } else {
      flags.push(...(resume ? ["-c", `sandbox_mode="workspace-write"`] : ["--sandbox", "workspace-write"]), "-c", `approval_policy="never"`);
      // Worktree tabs: the real .git lives outside the workspace — without
      // this, every git mutation dies on the sandbox wall (JSON string arrays
      // are valid TOML, which -c expects).
      if (opts.writableRoots?.length) flags.push("-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(opts.writableRoots)}`);
    }
    // `resume` is a subcommand that must immediately follow `exec`
    // (codex exec resume <SESSION_ID> [OPTS] [PROMPT]) — it was appended AFTER the
    // flags, so it was parsed as a prompt arg and resume never worked.
    return opts.sessionId
      ? ["exec", "resume", opts.sessionId, ...flags, prompt]
      : ["exec", ...flags, prompt];
  }
  // claude
  const args = ["-p"];
  // Bridge mode delivers the prompt as a stream-json `user` message on stdin so
  // the control protocol can carry permission requests back to gearbox; the
  // non-bridge path passes the prompt as the positional arg as before.
  if (!opts.bridge) args.push(prompt);
  args.push("--output-format", "stream-json", "--verbose");
  if (opts.bridge) args.push("--input-format", "stream-json", "--permission-prompt-tool", "stdio");
  if (model) args.push("--model", model);
  args.push("--permission-mode", opts.readOnly ? "plan" : opts.autoApprove ? "bypassPermissions" : "acceptEdits");
  // Headless `claude -p` can't show its own approval UI. Two complementary
  // mechanisms keep a turn working without /yolo:
  //  - The interactive BRIDGE (opts.bridge, see runCliTask): any tool the CLI
  //    would prompt for fires a `can_use_tool` control request that gearbox
  //    answers from its OWN permission prompt. This is the general fix.
  //  - Pre-grants below skip the prompt entirely for things that are always
  //    safe, so the bridge only bothers the user with genuinely novel actions:
  //    --add-dir (pasted-screenshot temp dirs, a linked worktree's real git
  //    dir, the scratch dir) and --allowedTools (read-only git verbs).
  for (const d of opts.addDirs ?? []) args.push("--add-dir", d);
  if (!opts.readOnly && !opts.autoApprove) {
    // Pre-grant only READ-ONLY git verbs (no `worktree` — its add/remove mutate
    // the filesystem outside the repo, so it goes through the bridge prompt like
    // any other novel action rather than running silently). SAFETY ASSUMPTION:
    // the `:*` suffix wildcard relies on `claude` splitting compound commands and
    // re-checking each segment (so `git status && rm -rf` is NOT auto-approved);
    // verified against claude v2.1.170. If a future CLI drops that split, these
    // become a chaining vector — re-verify on CLI upgrades.
    // The allow-rule grammar matches a command PREFIX: `Bash(git status:*)` only
    // fires when the command literally starts with `git status`. Models often
    // write `git -C <repo> status …` for explicitness, and the inserted `-C
    // <path>` defeats the prefix match. We can't enumerate arbitrary `-C` paths,
    // but we DO know the repo root, so we also emit an exact `git -C <root> …`
    // rule for it. (The prompt also tells the agent to drop -C — a safety net.)
    const cmds = ["status", "log", "diff", "show", "branch"];
    const rules = cmds.map((c) => `Bash(git ${c}:*)`);
    // Reject `:` too — it's the grammar's command/args separator, so a repo path
    // containing it would emit a malformed (over/under-matching) rule.
    if (opts.repoRoot && !/[\s,():]/.test(opts.repoRoot)) for (const c of cmds) rules.push(`Bash(git -C ${opts.repoRoot} ${c}:*)`);
    args.push("--allowedTools", rules.join(","));
  }
  if (opts.sessionId) args.push("--resume", opts.sessionId);
  return args;
}

/** Parse a finished/streamed sequence of NDJSON lines (testable; no subprocess). */
export function parseCliLines(binary: string, lines: string[], onEvent: OnEvent): CliResult {
  const state = newState();
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let obj: any;
    try {
      obj = JSON.parse(t);
    } catch {
      continue; // non-JSON noise
    }
    mapCliEvent(binary, obj, state, onEvent);
  }
  return finalize(state);
}

function finalize(state: CliState): CliResult {
  return { messages: [], usage: state.usage, sessionId: state.sessionId, costUSD: state.costUSD, model: state.model, rates: [...state.rates.values()] };
}

function cleanCliStderr(text: string): string {
  const cleaned = text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 1200);
  if (/--full-auto.*deprecated/i.test(cleaned) || /unexpected argument '--ask-for-approval'/i.test(cleaned)) {
    return "Gearbox passed a Codex CLI flag this installed Codex does not support. Update Gearbox and retry.";
  }
  return cleaned;
}

function cliFailureMessage(binary: string, stderr: string, opts: { accountLabel?: string; reloginCommand?: string } = {}): string {
  const err = cleanCliStderr(stderr);
  const isCodex = binary.includes("codex");
  if (isCodex && /app_session_terminated|Your session has ended|Failed to refresh token|HTTP error: 401 Unauthorized/i.test(err)) {
    const account = opts.accountLabel ? ` for ${opts.accountLabel}` : "";
    const relogin = opts.reloginCommand ? ` Run ${opts.reloginCommand} to sign in again, then /retry.` : " Sign in to that Codex account again, then /retry.";
    return `Codex session expired${account}.${relogin}`;
  }
  const hint = isCodex
    ? "Codex CLI failed before returning an assistant message. Check the line above, then /retry."
    : `${binary} failed before returning an assistant message. Check the line above, then /retry.`;
  return err ? `${hint} ${err}` : hint;
}

/** Run a turn through the vendor CLI subprocess, emitting AgentEvents. */
export async function runCliTask(opts: {
  binary: string;
  prompt: string;
  messages: ModelMessage[];
  onEvent: OnEvent;
  signal?: AbortSignal;
  sessionId?: string;
  autoApprove?: boolean;
  readOnly?: boolean; // headless one-shot without --yolo: plan mode / read-only sandbox
  oauthToken?: string; // claude 1-year setup token → CLAUDE_CODE_OAUTH_TOKEN (collision-free auth)
  modelId?: string;
  effort?: string;
  cwd?: string;
  profile?: string; // per-account config dir (multi-account); undefined = system default login
  accountLabel?: string;
  reloginCommand?: string;
  deferTerminal?: boolean; // suppress terminal error/done + return `failure` instead (caller drives failover)
}): Promise<CliResult> {
  const { binary, prompt, messages, onEvent, signal } = opts;
  // Codex's workspace-write sandbox blocks writes to a worktree's real git dir;
  // give it those roots explicitly.
  const wr = binary.includes("codex") ? worktreeGitRoots(opts.cwd ?? process.cwd()) : [];
  // Same out-of-workspace allowances the in-loop tools get (paste temp dirs,
  // linked-worktree git dir), plus the gearbox scratch dir so the headless
  // agent has somewhere pre-approved to put worktrees/scratch files outside
  // the repo — best-effort; an fs hiccup must not kill the turn.
  let addDirs: string[] = [];
  try { addDirs = defaultReadRoots(opts.cwd ?? process.cwd()); } catch { /* keep empty */ }
  try { mkdirSync(cliScratchDir(), { recursive: true }); addDirs.push(cliScratchDir()); } catch { /* keep going */ }
  // Interactive permission bridge: only `claude` speaks the control protocol,
  // and only when we're NOT already auto-approving (yolo → bypassPermissions)
  // or read-only (plan, no mutations). When on, the prompt rides stdin as
  // stream-json and `can_use_tool` requests route to gearbox's own prompt.
  const bridge = binary.includes("claude") && !opts.autoApprove && !opts.readOnly;
  const args = buildCliArgs(binary, prompt, { writableRoots: wr, sessionId: opts.sessionId, autoApprove: opts.autoApprove, readOnly: opts.readOnly, modelId: opts.modelId, effort: opts.effort, addDirs, repoRoot: opts.cwd ?? process.cwd(), bridge });
  const state = newState();
  let failureMessage: string | undefined;
  const fail = (message: string) => {
    if (failureMessage) return;
    failureMessage = message;
    if (!opts.deferTerminal) onEvent({ type: "error", message });
  };

  let proc: Proc;
  try {
    proc = spawnProc([binary, ...args], { stdin: bridge ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe", cwd: opts.cwd ?? process.cwd(), env: subscriptionEnv(binary, opts.profile, opts.oauthToken) });
  } catch (e: any) {
    fail(`couldn't start ${binary}: ${e?.message ?? e}`);
    if (!opts.deferTerminal) onEvent({ type: "done", usage: state.usage });
    return { ...finalize(state), failure: { message: failureMessage! } };
  }

  // ── interactive permission bridge (claude control protocol over stdin) ──────
  const send = (o: any) => { try { proc.stdin?.write(JSON.stringify(o) + "\n"); } catch { /* stdin closed */ } };
  let userSent = false;
  const sendUser = () => { if (userSent) return; userSent = true; send({ type: "user", message: { role: "user", content: prompt } }); };
  let initFallback: ReturnType<typeof setTimeout> | undefined;
  if (bridge) {
    // Initialize, then deliver the prompt once the CLI acks (with a fallback in
    // case the ack never arrives, so the turn can't deadlock before it starts).
    send({ type: "control_request", request_id: "gearbox-init", request: { subtype: "initialize" } });
    initFallback = setTimeout(sendUser, 1500);
  }
  // Answer one can_use_tool request via gearbox's permission broker. Awaited in
  // the read loop, which is fine: the CLI blocks for the response anyway.
  const answerPermission = async (requestId: string, req: any) => {
    const { kind, title, detail } = cliToolPermission(req?.tool_name, req?.input, req?.description);
    let ok = false;
    try { ok = await requestPermission({ kind, title, detail, root: opts.cwd ?? process.cwd() }); } catch { ok = false; }
    send({
      type: "control_response",
      response: ok
        ? { subtype: "success", request_id: requestId, response: { behavior: "allow", updatedInput: req?.input ?? {} } }
        : { subtype: "success", request_id: requestId, response: { behavior: "deny", message: "Denied in gearbox." } },
    });
  };

  // SIGTERM, then escalate to SIGKILL if the vendor CLI ignores it — a wedged
  // claude/codex (e.g. stuck in a network wait) would otherwise keep `await
  // proc.exited` pending forever, pinning the turn's `busy` with no way out.
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => {
    proc.kill();
    killTimer = setTimeout(() => proc.kill("SIGKILL"), 2000);
  };
  signal?.addEventListener("abort", onAbort);

  const outDec = new TextDecoder();
  const errDec = new TextDecoder();
  let buf = "";
  let stderr = "";
  let sawEvent = false;
  try {
    // Handle one parsed stdout message. Control-protocol frames (bridge mode)
    // are consumed here and never forwarded to mapCliEvent — they're transport,
    // not assistant content. Returns once any async permission prompt settles.
    const handleMessage = async (m: any): Promise<void> => {
      if (bridge) {
        if (m?.type === "control_response") {
          if (m.response?.request_id === "gearbox-init") { if (initFallback) clearTimeout(initFallback); sendUser(); }
          return;
        }
        if (m?.type === "control_request") {
          if (m.request?.subtype === "can_use_tool") await answerPermission(m.request_id, m.request);
          return; // ignore other control_request subtypes (we registered no hooks)
        }
      }
      mapCliEvent(binary, m, state, onEvent);
      sawEvent = true;
      if (bridge && m?.type === "result") { try { proc.stdin?.end(); } catch { /* already closed */ } }
    };
    const readStdout = async () => {
      for await (const chunk of proc.stdout as any) {
        buf += outDec.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const t = line.trim();
          if (!t) continue;
          let m: any;
          try { m = JSON.parse(t); } catch { continue; /* non-JSON line */ }
          await handleMessage(m);
        }
      }
      if (buf.trim()) {
        let m: any;
        try { m = JSON.parse(buf.trim()); } catch { return; /* trailing non-JSON */ }
        await handleMessage(m);
      }
    };
    const readStderr = async () => {
      for await (const chunk of proc.stderr as any) {
        stderr += errDec.decode(chunk, { stream: true });
        if (stderr.length > 4000) stderr = stderr.slice(-4000);
      }
    };
    await Promise.all([readStdout(), readStderr(), proc.exited]);
  } catch (e: any) {
    if (!signal?.aborted) fail(e?.message ?? String(e));
  } finally {
    if (killTimer) clearTimeout(killTimer);
    if (initFallback) clearTimeout(initFallback);
    signal?.removeEventListener("abort", onAbort);
  }
  if (!signal?.aborted) {
    const err = cleanCliStderr(stderr);
    if ((proc.exitCode ?? 0) !== 0) {
      fail(cliFailureMessage(binary, stderr, { accountLabel: opts.accountLabel, reloginCommand: opts.reloginCommand }));
    } else if (!state.text && !sawEvent && err) {
      fail(`${binary} produced no JSON output: ${err}`);
    } else if (!state.text && !sawEvent) {
      fail(`${binary} finished without an assistant message`);
    }
  }

  // Plain-text ledger entry (tool history isn't portable across binaries).
  const next: ModelMessage[] = [...messages, { role: "user", content: prompt }];
  if (state.text) next.push({ role: "assistant", content: state.text });
  if (!opts.deferTerminal) onEvent({ type: "done", usage: state.usage });
  return { messages: next, usage: state.usage, sessionId: state.sessionId, costUSD: state.costUSD, model: state.model, rates: [...state.rates.values()], failure: failureMessage ? { message: failureMessage } : undefined };
}
