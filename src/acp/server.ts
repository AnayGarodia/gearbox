/**
 * acp/server.ts — the `gearbox acp` agent: ACP over stdio, no Ink, no TTY.
 *
 * An editor (Zed, JetBrains, Neovim) spawns `gearbox acp` and speaks
 * newline-delimited JSON-RPC on stdin/stdout. Each editor thread is an ACP
 * session backed by gearbox's normal turn machinery: RoutingSelector picks
 * the model per prompt, buildContext curates, runTask streams AgentEvents,
 * and protocol.ts maps those events to session/update notifications.
 * Permission prompts route to the EDITOR via session/request_permission —
 * the broker's handler seam, same as the TUI installs.
 *
 * STDOUT IS THE WIRE. Nothing in this path may print: no Ink, no onboarding,
 * no console.log. Diagnostics go to stderr.
 */
import pkg from "../../package.json";
import { runTask } from "../agent/run.ts";
import type { AgentEvent } from "../agent/events.ts";
import { RoutingSelector } from "../model/router.ts";
import { buildContext } from "../context/builder.ts";
import { resolveCreds } from "../accounts/resolve.ts";
import { defaultAccount } from "../accounts/store.ts";
import { recordSpend, resolveTurnCost } from "../accounts/ledger.ts";
import { setPermissionHandler, type PermRequest } from "../permission.ts";
import { newSessionId, saveSession, type Session } from "../session.ts";
import type { ModelMessage } from "ai";
import {
  ACP_PROTOCOL_VERSION,
  PERMISSION_OPTIONS,
  decodeLines,
  encodeMessage,
  eventToUpdates,
  initializeResult,
  newEventMapState,
  outcomeToDecision,
  promptText,
  type ContentBlock,
  type RpcMessage,
} from "./protocol.ts";

interface AcpSession {
  id: string;
  cwd: string;
  messages: ModelMessage[];
  abort: AbortController | null;
  record: Session; // persisted best-effort so `gearbox --continue` can pick the thread up
}

/** A single prompt turn: routed, curated, run. Injectable so tests drive the
 *  whole server loop without a model. */
export type TurnRunner = (opts: {
  prompt: string;
  history: ModelMessage[];
  cwd: string;
  signal: AbortSignal;
  onEvent: (e: AgentEvent) => void;
}) => Promise<{ messages: ModelMessage[]; failure?: { message: string } }>;

const defaultRunner: TurnRunner = async ({ prompt, history, cwd, signal, onEvent }) => {
  let choice;
  try {
    choice = new RoutingSelector().select({ prompt, requires: ["tools"] });
  } catch {
    choice = new RoutingSelector().select({ prompt });
  }
  const acct = (choice.backend?.kind === "in-loop" && choice.backend.account) || defaultAccount(choice.model.provider);
  const creds = acct ? await resolveCreds(acct) : undefined;
  const { system, messages, cacheBreak } = buildContext({ history, userText: prompt, model: choice.model, cwd });
  const r = await runTask({
    model: choice.model,
    messages,
    system,
    creds,
    cacheBreak,
    root: cwd,
    onEvent,
    signal,
    maxRetries: 2,
    deferTerminal: true, // failures come back in the result; the wire owns the outcome
  });
  try {
    recordSpend({
      accountId: acct?.id ?? `env:${choice.model.provider}`,
      model: choice.model.id,
      source: "turn",
      inputTokens: r.usage.inputTokens,
      outputTokens: r.usage.outputTokens,
      ...resolveTurnCost({ modelId: choice.model.id, isSub: false, usage: r.usage }),
      at: Date.now(),
    });
  } catch {
    /* spend recording must never break the wire */
  }
  return { messages: r.messages, failure: r.failure ? { message: r.failure.message } : undefined };
};

export class AcpServer {
  private sessions = new Map<string, AcpSession>();
  private buffer = "";
  private nextOutboundId = 1;
  private pending = new Map<string | number, (msg: RpcMessage) => void>();
  private initialized = false;

  constructor(
    private write: (line: string) => void,
    private runner: TurnRunner = defaultRunner,
  ) {
    // Route gearbox permission prompts to the editor. One client per process,
    // so the global handler slot is exactly right.
    setPermissionHandler(async (req: PermRequest) => {
      const session = this.sessionForRoot(req.root) ?? [...this.sessions.values()].at(-1);
      if (!session) return "deny"; // a request outside any session has no one to ask
      const result = await this.request("session/request_permission", {
        sessionId: session.id,
        toolCall: {
          toolCallId: `perm-${this.nextOutboundId}`,
          title: `${req.title}: ${req.detail}`,
          kind: req.kind === "shell" ? "execute" : "edit",
          status: "pending",
          rawInput: { detail: req.detail },
        },
        options: PERMISSION_OPTIONS,
      });
      return outcomeToDecision(result?.outcome);
    });
  }

  private sessionForRoot(root?: string): AcpSession | undefined {
    if (!root) return undefined;
    return [...this.sessions.values()].find((s) => s.cwd === root);
  }

  /** Feed raw stdin bytes; complete lines are dispatched in arrival order. */
  async feed(chunk: string): Promise<void> {
    const { messages, rest } = decodeLines(this.buffer + chunk);
    this.buffer = rest;
    for (const msg of messages) {
      if ("parseError" in msg) {
        this.write(encodeMessage({ jsonrpc: "2.0", id: null as any, error: { code: -32700, message: "parse error" } }));
        continue;
      }
      await this.dispatch(msg);
    }
  }

  private notify(method: string, params: unknown): void {
    this.write(encodeMessage({ jsonrpc: "2.0", method, params }));
  }

  /** Agent → client request (permissions). Resolves with the client's response. */
  private request(method: string, params: unknown): Promise<any> {
    const id = `gbx-${this.nextOutboundId++}`;
    return new Promise((resolve) => {
      this.pending.set(id, (msg) => resolve(msg.result));
      this.write(encodeMessage({ jsonrpc: "2.0", id, method, params }));
    });
  }

  private respond(id: string | number, result: unknown): void {
    this.write(encodeMessage({ jsonrpc: "2.0", id, result }));
  }

  private fail(id: string | number, code: number, message: string): void {
    this.write(encodeMessage({ jsonrpc: "2.0", id, error: { code, message } }));
  }

  private async dispatch(msg: RpcMessage): Promise<void> {
    // A response to one of OUR requests (permission outcomes).
    if (msg.id !== undefined && msg.method === undefined) {
      const waiter = this.pending.get(msg.id);
      if (waiter) {
        this.pending.delete(msg.id);
        waiter(msg);
      }
      return;
    }
    const id = msg.id;
    try {
      switch (msg.method) {
        case "initialize": {
          this.initialized = true;
          this.respond(id!, initializeResult(pkg.version));
          return;
        }
        case "authenticate":
          this.respond(id!, null);
          return;
        case "session/new": {
          const cwd: string = msg.params?.cwd || process.cwd();
          const sid = `gbx-sess-${newSessionId()}`;
          const record: Session = { id: newSessionId(), cwd, createdAt: Date.now(), updatedAt: Date.now(), title: "", messages: [], items: [], turns: [] };
          this.sessions.set(sid, { id: sid, cwd, messages: [], abort: null, record });
          this.respond(id!, { sessionId: sid });
          return;
        }
        case "session/prompt": {
          const session = this.sessions.get(msg.params?.sessionId);
          if (!session) return this.fail(id!, -32602, `unknown session: ${msg.params?.sessionId}`);
          const prompt = promptText((msg.params?.prompt ?? []) as ContentBlock[]);
          if (!prompt) return this.respond(id!, { stopReason: "end_turn" });
          const abort = new AbortController();
          session.abort = abort;
          const mapState = newEventMapState();
          const onEvent = (e: AgentEvent) => {
            for (const update of eventToUpdates(e, mapState)) this.notify("session/update", { sessionId: session.id, update });
          };
          try {
            const r = await this.runner({ prompt, history: session.messages, cwd: session.cwd, signal: abort.signal, onEvent });
            session.messages = r.messages;
            this.persist(session, prompt);
            if (abort.signal.aborted) return this.respond(id!, { stopReason: "cancelled" });
            if (r.failure) {
              // Surface the failure as prose (editors render it inline), then
              // end the turn as a refusal rather than a JSON-RPC error — the
              // protocol reserves errors for protocol-level problems.
              this.notify("session/update", {
                sessionId: session.id,
                update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n${r.failure.message}` } },
              });
              return this.respond(id!, { stopReason: "refusal" });
            }
            return this.respond(id!, { stopReason: "end_turn" });
          } finally {
            session.abort = null;
          }
        }
        case "session/cancel": {
          const session = this.sessions.get(msg.params?.sessionId);
          session?.abort?.abort();
          return; // notification: no response
        }
        default:
          if (id !== undefined) this.fail(id, -32601, `method not found: ${msg.method}`);
      }
    } catch (e: any) {
      if (id !== undefined) this.fail(id, -32603, e?.message ?? String(e));
    }
  }

  /** Best-effort session persistence so an ACP thread shows up in /resume. */
  private persist(session: AcpSession, lastPrompt: string): void {
    try {
      session.record.messages = session.messages;
      session.record.updatedAt = Date.now();
      if (!session.record.title) session.record.title = lastPrompt.slice(0, 80);
      saveSession(session.record, session.cwd);
    } catch {
      /* never break the wire over persistence */
    }
  }
}

/** Entry point for the `gearbox acp` subcommand: bind the server to stdio. */
export async function runAcpStdio(): Promise<void> {
  const server = new AcpServer((line) => process.stdout.write(line));
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin as AsyncIterable<string>) {
    await server.feed(chunk);
  }
}
