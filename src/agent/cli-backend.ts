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
import type { Proc } from "../proc.ts";

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

export function subscriptionEnv(binary: string, profile?: string): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const k of KEYS_TO_STRIP[binary] ?? []) delete env[k];
  if (profile && CONFIG_DIR_VAR[binary]) env[CONFIG_DIR_VAR[binary]!] = profile;
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

export function buildCliArgs(binary: string, prompt: string, opts: { sessionId?: string; autoApprove?: boolean; modelId?: string; effort?: string } = {}): string[] {
  const model = cliModelArg(binary, opts.modelId);
  if (binary.includes("codex")) {
    // Auth still comes from CODEX_HOME, but user config can contain hooks/MCP
    // settings that are stale or unsafe for this subprocess. Keep Gearbox's
    // subscription bridge clean and let the Codex CLI own the actual turn.
    const flags: string[] = ["--json", "--skip-git-repo-check", "--ignore-user-config"];
    if (model) flags.push("--model", model);
    if (opts.effort) flags.push("-c", `model_reasoning_effort="${opts.effort}"`);
    if (opts.autoApprove) flags.push("--dangerously-bypass-approvals-and-sandbox");
    else flags.push("--sandbox", "workspace-write", "-c", `approval_policy="never"`);
    // `resume` is a subcommand that must immediately follow `exec`
    // (codex exec resume <SESSION_ID> [OPTS] [PROMPT]) — it was appended AFTER the
    // flags, so it was parsed as a prompt arg and resume never worked.
    return opts.sessionId
      ? ["exec", "resume", opts.sessionId, ...flags, prompt]
      : ["exec", ...flags, prompt];
  }
  // claude
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];
  if (model) args.push("--model", model);
  args.push("--permission-mode", opts.autoApprove ? "bypassPermissions" : "acceptEdits");
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
  modelId?: string;
  effort?: string;
  cwd?: string;
  profile?: string; // per-account config dir (multi-account); undefined = system default login
  accountLabel?: string;
  reloginCommand?: string;
  deferTerminal?: boolean; // suppress terminal error/done + return `failure` instead (caller drives failover)
}): Promise<CliResult> {
  const { binary, prompt, messages, onEvent, signal } = opts;
  const args = buildCliArgs(binary, prompt, { sessionId: opts.sessionId, autoApprove: opts.autoApprove, modelId: opts.modelId, effort: opts.effort });
  const state = newState();
  let failureMessage: string | undefined;
  const fail = (message: string) => {
    if (failureMessage) return;
    failureMessage = message;
    if (!opts.deferTerminal) onEvent({ type: "error", message });
  };

  let proc: Proc;
  try {
    proc = spawnProc([binary, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", cwd: opts.cwd ?? process.cwd(), env: subscriptionEnv(binary, opts.profile) });
  } catch (e: any) {
    fail(`couldn't start ${binary}: ${e?.message ?? e}`);
    if (!opts.deferTerminal) onEvent({ type: "done", usage: state.usage });
    return { ...finalize(state), failure: { message: failureMessage! } };
  }

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
    const readStdout = async () => {
      for await (const chunk of proc.stdout as any) {
        buf += outDec.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const t = line.trim();
          if (!t) continue;
          try {
            mapCliEvent(binary, JSON.parse(t), state, onEvent);
            sawEvent = true;
          } catch {
            /* non-JSON line */
          }
        }
      }
      if (buf.trim()) {
        try {
          mapCliEvent(binary, JSON.parse(buf.trim()), state, onEvent);
          sawEvent = true;
        } catch {
          /* trailing non-JSON */
        }
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
