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
import { newSessionId, saveSession, loadSession, type Session } from "../session.ts";
import { clientFsTools, type ClientFsCaps } from "./client-fs.ts";
import type { ModelMessage } from "ai";
import {
  PERMISSION_OPTIONS,
  decodeLines,
  encodeMessage,
  eventToUpdates,
  initializeResult,
  newEventMapState,
  outcomeToDecision,
  promptText,
  replayUpdates,
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
  /** Tool overrides (editor-buffer fs); merged last over the built-in set. */
  extraTools?: Record<string, any>;
}) => Promise<{ messages: ModelMessage[]; failure?: { message: string } }>;

const defaultRunner: TurnRunner = async ({ prompt, history, cwd, signal, onEvent, extraTools }) => {
  let choice;
  // inLoopOnly: the ACP server has no seat (vendor-CLI) dispatch machinery, so
  // a ~free subscription seat must never win the pick — it would silently be
  // re-run against a metered API key (wrong economics, wrong account).
  try {
    choice = new RoutingSelector().select({ prompt, requires: ["tools"], inLoopOnly: true });
  } catch {
    choice = new RoutingSelector().select({ prompt, inLoopOnly: true });
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
    extraTools,
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
  private permSeq = 0;
  private pending = new Map<string | number, (msg: RpcMessage) => void>();
  private initialized = false;
  private fsCaps: ClientFsCaps = {};

  constructor(
    private write: (line: string) => void,
    private runner: TurnRunner = defaultRunner,
    private opts: { requestTimeoutMs?: number } = {},
  ) {
    // Route gearbox permission prompts to the editor. One client per process,
    // so the global handler slot is exactly right.
    setPermissionHandler(async (req: PermRequest) => {
      const session = this.sessionFor(req.root);
      if (!session) return "deny"; // a request outside any session has no one to ask
      try {
        const result = await this.request("session/request_permission", {
          sessionId: session.id,
          toolCall: {
            toolCallId: `perm-${++this.permSeq}`,
            title: `${req.title}: ${req.detail}`,
            kind: req.kind === "shell" ? "execute" : "edit",
            status: "pending",
            rawInput: { detail: req.detail },
          },
          options: PERMISSION_OPTIONS,
        });
        return outcomeToDecision(result?.outcome);
      } catch {
        return "deny"; // client never answered (timeout) — an unanswered escalation is a refusal
      }
    });
  }

  /** Resolve which session a permission request belongs to. Root-stamped
   *  requests match on cwd (preferring the one mid-turn — two editor windows
   *  can share a project); rootless requests (MCP tools) belong to the
   *  session whose turn is running. No running turn + no root match → nobody
   *  to ask, and the caller denies. */
  private sessionFor(root?: string): AcpSession | undefined {
    const all = [...this.sessions.values()];
    const pool = root ? all.filter((s) => s.cwd === root) : all;
    return pool.filter((s) => s.abort).at(-1) ?? (root ? pool.at(-1) : undefined);
  }

  /** Feed raw stdin bytes; complete lines are dispatched in arrival order. */
  async feed(chunk: string): Promise<void> {
    const { messages, rest } = decodeLines(this.buffer + chunk);
    // A peer streaming bytes with no newline must not grow the buffer without
    // bound. ACP frames are single lines; 8MB is far past any real frame.
    this.buffer = rest.length > 8_000_000 ? "" : rest;
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

  /** Agent → client request (permissions, editor fs). Resolves with the
   *  client's response; REJECTS after `timeoutMs` so a client that never
   *  answers can't park a turn (and its model call) forever. */
  private request(method: string, params: unknown, timeoutMs = this.opts.requestTimeoutMs ?? 600_000): Promise<any> {
    const id = `gbx-${this.nextOutboundId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`client did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg.result);
      });
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
    // Everything but initialize requires the handshake first (notifications
    // are silently ignored — there is no id to answer on).
    if (!this.initialized && msg.method !== "initialize") {
      if (id !== undefined) this.fail(id, -32002, "agent not initialized: send initialize first");
      return;
    }
    try {
      switch (msg.method) {
        case "initialize": {
          this.initialized = true;
          this.fsCaps = msg.params?.clientCapabilities?.fs ?? {};
          this.respond(id!, initializeResult(pkg.version));
          return;
        }
        case "authenticate":
          this.respond(id!, null);
          return;
        case "session/new": {
          const cwd: string = msg.params?.cwd || process.cwd();
          const recordId = newSessionId();
          // The record id IS the ACP suffix, so session/load can find it again.
          const sid = `gbx-sess-${recordId}`;
          const record: Session = { id: recordId, cwd, createdAt: Date.now(), updatedAt: Date.now(), title: "", messages: [], items: [], turns: [] };
          this.sessions.set(sid, { id: sid, cwd, messages: [], abort: null, record });
          this.respond(id!, { sessionId: sid });
          return;
        }
        case "session/load": {
          const cwd: string = msg.params?.cwd || process.cwd();
          const sid: string = msg.params?.sessionId ?? "";
          // The suffix feeds a filesystem join — validate the exact shape we
          // mint (newSessionId: "s" + base36) so a hostile client id can never
          // traverse out of the sessions dir.
          if (!/^gbx-sess-s[a-z0-9]+$/.test(sid)) return this.fail(id!, -32602, `unknown session: ${sid}`);
          const record = loadSession(sid.replace(/^gbx-sess-/, ""), cwd);
          if (!record) return this.fail(id!, -32602, `unknown session: ${sid}`);
          this.sessions.set(sid, { id: sid, cwd, messages: record.messages, abort: null, record });
          // Contract: replay the whole conversation as updates, THEN return null.
          for (const update of replayUpdates(record.messages as any)) this.notify("session/update", { sessionId: sid, update });
          this.respond(id!, null);
          return;
        }
        case "session/prompt": {
          const session = this.sessions.get(msg.params?.sessionId);
          if (!session) return this.fail(id!, -32602, `unknown session: ${msg.params?.sessionId}`);
          // One turn per session at a time (the ACP contract). A second prompt
          // mid-turn would clobber the abort controller and race the history.
          if (session.abort) return this.fail(id!, -32600, "a prompt is already running for this session");
          const prompt = promptText((msg.params?.prompt ?? []) as ContentBlock[]);
          if (!prompt) return this.respond(id!, { stopReason: "end_turn" });
          // DELIBERATELY NOT AWAITED: the stdio read loop awaits dispatch, and
          // this turn cannot finish until the client's permission / editor-fs
          // RESPONSES arrive on that same loop. Awaiting here would deadlock
          // the first write in a real editor and make session/cancel
          // unreachable. runPrompt answers `id` itself and never throws.
          void this.runPrompt(session, id!, prompt);
          return;
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

  /** The body of a session/prompt turn. Owns answering `id` (including on
   *  throw) — the dispatcher fire-and-forgets this so the read loop stays
   *  free to deliver permission responses and session/cancel mid-turn. */
  private async runPrompt(session: AcpSession, id: string | number, prompt: string): Promise<void> {
    const abort = new AbortController();
    session.abort = abort;
    const mapState = newEventMapState();
    const onEvent = (e: AgentEvent) => {
      for (const update of eventToUpdates(e, mapState)) this.notify("session/update", { sessionId: session.id, update });
    };
    // Editor-buffer fs: when the client advertises fs methods, reads see
    // unsaved buffers and writes land in the open tab.
    const fsTools = clientFsTools({ sessionId: session.id, cwd: session.cwd, caps: this.fsCaps, request: (m, p) => this.request(m, p) });
    const extraTools = Object.keys(fsTools).length ? fsTools : undefined;
    try {
      const r = await this.runner({ prompt, history: session.messages, cwd: session.cwd, signal: abort.signal, onEvent, extraTools });
      session.messages = r.messages;
      this.persist(session, prompt);
      if (abort.signal.aborted) return this.respond(id, { stopReason: "cancelled" });
      if (r.failure) {
        // Surface the failure as prose (editors render it inline), then
        // end the turn as a refusal rather than a JSON-RPC error — the
        // protocol reserves errors for protocol-level problems.
        this.notify("session/update", {
          sessionId: session.id,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n${r.failure.message}` } },
        });
        return this.respond(id, { stopReason: "refusal" });
      }
      return this.respond(id, { stopReason: "end_turn" });
    } catch (e: any) {
      this.fail(id, -32603, e?.message ?? String(e));
    } finally {
      session.abort = null;
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
