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

export interface CliRate {
  utilization: number;
  resetsAt?: number;
  type?: string;
}

export interface CliResult {
  messages: ModelMessage[];
  usage: Usage;
  sessionId?: string; // the binary's own session id, for resume
  costUSD?: number; // claude reports this; codex doesn't
  rate?: CliRate; // claude's rate_limit_event (quota utilization)
}

// Accumulates across a stream so runCliTask can build the result.
interface CliState {
  text: string;
  usage: Usage;
  sessionId?: string;
  costUSD?: number;
  rate?: CliRate;
  toolNames: Map<string, string>;
}

function newState(): CliState {
  return { text: "", usage: { inputTokens: 0, outputTokens: 0 }, toolNames: new Map() };
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
        if (obj.usage) {
          state.usage.inputTokens = obj.usage.input_tokens ?? 0;
          state.usage.outputTokens = obj.usage.output_tokens ?? 0;
        }
        break;
    }
    return;
  }

  // claude
  switch (obj?.type) {
    case "system":
      if (obj.subtype === "init" && obj.session_id) state.sessionId = obj.session_id;
      break; // hook_* noise ignored
    case "rate_limit_event": {
      const ri = obj.rate_limit_info;
      if (ri && typeof ri.utilization === "number") state.rate = { utilization: ri.utilization, resetsAt: ri.resetsAt, type: ri.rateLimitType };
      break;
    }
    case "assistant": {
      for (const part of obj.message?.content ?? []) {
        if (part.type === "text" && part.text) {
          state.text += part.text;
          onEvent({ type: "text", text: part.text });
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
      const u = obj.usage ?? {};
      state.usage.inputTokens = u.input_tokens ?? 0;
      state.usage.outputTokens = u.output_tokens ?? 0;
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

function shortArg(x: any): string {
  if (x == null) return "";
  if (typeof x === "string") return x.slice(0, 64);
  const s = x.command ?? x.path ?? x.file_path ?? x.cmd ?? "";
  return String(s).slice(0, 64);
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
export function buildCliArgs(binary: string, prompt: string, opts: { sessionId?: string; autoApprove?: boolean } = {}): string[] {
  if (binary.includes("codex")) {
    const args = ["exec", "--json", "--skip-git-repo-check"];
    if (opts.autoApprove) args.push("--dangerously-bypass-approvals-and-sandbox");
    else args.push("--full-auto");
    if (opts.sessionId) args.push("resume", opts.sessionId); // best-effort
    args.push(prompt);
    return args;
  }
  // claude
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];
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
  return { messages: [], usage: state.usage, sessionId: state.sessionId, costUSD: state.costUSD, rate: state.rate };
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
  cwd?: string;
  profile?: string; // per-account config dir (multi-account); undefined = system default login
}): Promise<CliResult> {
  const { binary, prompt, messages, onEvent, signal } = opts;
  const args = buildCliArgs(binary, prompt, { sessionId: opts.sessionId, autoApprove: opts.autoApprove });
  const state = newState();

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([binary, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", cwd: opts.cwd ?? process.cwd(), env: subscriptionEnv(binary, opts.profile) });
  } catch (e: any) {
    onEvent({ type: "error", message: `couldn't start ${binary}: ${e?.message ?? e}` });
    onEvent({ type: "done", usage: state.usage });
    return finalize(state);
  }

  const onAbort = () => proc.kill();
  signal?.addEventListener("abort", onAbort);

  const dec = new TextDecoder();
  let buf = "";
  try {
    for await (const chunk of proc.stdout as any) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const t = line.trim();
        if (!t) continue;
        try {
          mapCliEvent(binary, JSON.parse(t), state, onEvent);
        } catch {
          /* non-JSON line */
        }
      }
    }
    if (buf.trim()) {
      try {
        mapCliEvent(binary, JSON.parse(buf.trim()), state, onEvent);
      } catch {
        /* trailing non-JSON */
      }
    }
    await proc.exited;
  } catch (e: any) {
    if (!signal?.aborted) onEvent({ type: "error", message: e?.message ?? String(e) });
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }

  // Plain-text ledger entry (tool history isn't portable across binaries).
  const next: ModelMessage[] = [...messages, { role: "user", content: prompt }];
  if (state.text) next.push({ role: "assistant", content: state.text });
  onEvent({ type: "done", usage: state.usage });
  return { messages: next, usage: state.usage, sessionId: state.sessionId, costUSD: state.costUSD, rate: state.rate };
}
