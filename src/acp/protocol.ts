/**
 * acp/protocol.ts — pure ACP (Agent Client Protocol) building blocks.
 *
 * ACP is the Zed-originated editor↔agent protocol (agentclientprotocol.com):
 * JSON-RPC 2.0, newline-delimited (one compact JSON object per line, UTF-8,
 * no embedded newlines), spoken over the agent process's stdin/stdout.
 * protocolVersion is a single integer; we implement version 1.
 *
 * This module holds everything PURE: message framing, the AgentEvent →
 * session/update mapping, tool-kind classification, and the permission
 * option/decision tables. The stdio loop and session state live in server.ts.
 */
import type { AgentEvent } from "../agent/events.ts";

export const ACP_PROTOCOL_VERSION = 1;

// ── JSON-RPC framing ───────────────────────────────────────────────────────

export interface RpcMessage {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

/**
 * Consume newline-delimited JSON from an accumulating buffer. Returns the
 * parsed messages plus the unconsumed remainder (a partial trailing line).
 * Malformed lines yield a `parseError` marker so the caller can answer with
 * JSON-RPC -32700 instead of dying.
 */
export function decodeLines(buffer: string): { messages: (RpcMessage | { parseError: true })[]; rest: string } {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const messages: (RpcMessage | { parseError: true })[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      messages.push(JSON.parse(line));
    } catch {
      messages.push({ parseError: true });
    }
  }
  return { messages, rest };
}

/** One compact JSON object per line — the wire format both directions. */
export function encodeMessage(msg: RpcMessage): string {
  return JSON.stringify(msg) + "\n";
}

// ── content blocks & session updates ───────────────────────────────────────

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name: string }
  | { type: "resource"; resource: { uri: string; mimeType?: string; text?: string } };

export type SessionUpdate =
  | { sessionUpdate: "agent_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "agent_thought_chunk"; content: ContentBlock }
  | { sessionUpdate: "user_message_chunk"; content: ContentBlock }
  | {
      sessionUpdate: "tool_call";
      toolCallId: string;
      title: string;
      kind: ToolKind;
      status: "pending" | "in_progress" | "completed" | "failed";
      rawInput?: unknown;
      locations?: { path: string; line?: number }[];
    }
  | {
      sessionUpdate: "tool_call_update";
      toolCallId: string;
      status?: "pending" | "in_progress" | "completed" | "failed";
      title?: string;
      content?: ToolCallContent[];
      rawOutput?: unknown;
    };

export type ToolCallContent =
  | { type: "content"; content: ContentBlock }
  | { type: "diff"; path: string; oldText: string | null; newText: string };

export type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other";

/** Map a gearbox tool name to ACP's tool-kind vocabulary (drives editor icons). */
export function toolKind(name: string): ToolKind {
  switch (name) {
    case "read_file":
    case "list_dir":
      return "read";
    case "write_file":
    case "edit_file":
      return "edit";
    case "search":
    case "glob":
      return "search";
    case "run_shell":
      return "execute";
    case "fetch_url":
    case "web_search":
      return "fetch";
    case "delegate":
    case "delegate_parallel":
      return "think";
    default:
      return name.startsWith("mcp_") ? "other" : "other";
  }
}

/** Editor follow-along locations: file-path-shaped tool args become locations. */
function locationsFor(name: string, arg: string): { path: string }[] | undefined {
  if (!arg || !["read_file", "write_file", "edit_file"].includes(name)) return undefined;
  return [{ path: arg }];
}

/** Per-prompt mapping state: which tool ids have been announced, and a counter
 *  for synthetic verification tool calls. */
export interface EventMapState {
  announced: Set<string>;
  verifySeq: number;
}

export const newEventMapState = (): EventMapState => ({ announced: new Set(), verifySeq: 0 });

/**
 * Translate one gearbox AgentEvent into zero or more ACP session/update
 * payloads. The mapping is intentionally lossy where ACP has no slot
 * (phase/model-pick/file-change are gearbox-internal); everything an editor
 * can render — prose, tool lifecycle, live shell output, diffs, verification
 * results — comes through.
 */
export function eventToUpdates(e: AgentEvent, state: EventMapState): SessionUpdate[] {
  switch (e.type) {
    case "text":
      return e.text ? [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: e.text } }] : [];
    case "tool-start": {
      state.announced.add(e.id);
      return [
        {
          sessionUpdate: "tool_call",
          toolCallId: e.id,
          title: e.arg ? `${e.name}: ${e.arg}` : e.name,
          kind: toolKind(e.name),
          status: "in_progress",
          rawInput: e.arg ? { arg: e.arg } : undefined,
          locations: locationsFor(e.name, e.arg),
        },
      ];
    }
    case "tool-stream":
      // Title refinement only (the arg firms up as input streams in). Content
      // deltas are file bodies mid-write — too noisy for the editor feed.
      if (e.arg && state.announced.has(e.id)) return [{ sessionUpdate: "tool_call_update", toolCallId: e.id, title: e.arg }];
      return [];
    case "tool-output":
      if (!e.id || !state.announced.has(e.id)) return [];
      return [
        {
          sessionUpdate: "tool_call_update",
          toolCallId: e.id,
          content: [{ type: "content", content: { type: "text", text: e.text } }],
        },
      ];
    case "tool-end": {
      if (!state.announced.has(e.id)) return [];
      const content: ToolCallContent[] = [];
      if (e.summary) content.push({ type: "content", content: { type: "text", text: e.summary } });
      if (e.diff?.length) {
        const text = e.diff.map((l: any) => `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text ?? ""}`).join("\n");
        content.push({ type: "content", content: { type: "text", text } });
      }
      return [
        {
          sessionUpdate: "tool_call_update",
          toolCallId: e.id,
          status: e.ok ? "completed" : "failed",
          ...(content.length ? { content } : {}),
        },
      ];
    }
    case "verification": {
      // VERIFY runs are gearbox-initiated, so they have no tool-start; surface
      // them as a complete synthetic execute tool call (editors render a check).
      const id = `verify-${++state.verifySeq}`;
      return [
        { sessionUpdate: "tool_call", toolCallId: id, title: `verify: ${e.command}`, kind: "execute", status: "in_progress" },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          status: e.ok ? "completed" : "failed",
          content: [{ type: "content", content: { type: "text", text: e.summary } }],
        },
      ];
    }
    case "error":
      // No dedicated ACP slot — surface as prose so the editor shows WHY the
      // turn degraded instead of going silent (ACP has no failover hop-loop).
      return e.message ? [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n⚠ ${e.message}` } }] : [];
    default:
      return []; // phase, model-pick, file-change, preference-suggestion, done: no ACP slot
  }
}

// ── session/load replay ────────────────────────────────────────────────────

/** Flatten any ModelMessage content shape to plain text. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p: any) => (p?.type === "text" ? p.text : ""))
    .filter(Boolean)
    .join("");
}

/**
 * Replay a persisted conversation as session/update payloads (the protocol's
 * session/load contract: stream the whole history, then return null). User
 * turns become user_message_chunks, assistant prose agent_message_chunks, and
 * historical tool calls compact completed tool_call entries — enough for the
 * editor to render a faithful transcript without re-running anything.
 */
export function replayUpdates(messages: { role: string; content: unknown }[]): SessionUpdate[] {
  const out: SessionUpdate[] = [];
  let toolSeq = 0;
  for (const m of messages) {
    if (m.role === "user") {
      const text = contentText(m.content);
      if (text) out.push({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
    } else if (m.role === "assistant") {
      const text = contentText(m.content);
      if (text) out.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
      if (Array.isArray(m.content)) {
        for (const p of m.content as any[]) {
          if (p?.type !== "tool-call") continue;
          const arg = typeof p.input?.path === "string" ? p.input.path : typeof p.input?.command === "string" ? p.input.command : "";
          out.push({
            sessionUpdate: "tool_call",
            toolCallId: `replay-${++toolSeq}`,
            title: arg ? `${p.toolName}: ${arg}` : String(p.toolName ?? "tool"),
            kind: toolKind(String(p.toolName ?? "")),
            status: "completed",
          });
        }
      }
    }
    // tool-result messages carry no extra render value in a replay: the call
    // entries above already say what ran and that it completed.
  }
  return out;
}

// ── prompt content ─────────────────────────────────────────────────────────

/**
 * Flatten an ACP prompt (ContentBlock[]) into the user text gearbox builds
 * context from. resource_links and embedded resources become @-mention-style
 * references the retrieval layer already understands.
 */
export function promptText(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks ?? []) {
    if (b.type === "text") parts.push(b.text);
    else if (b.type === "resource_link") parts.push(`@${b.uri.replace(/^file:\/\//, "")}`);
    else if (b.type === "resource" && b.resource?.text) parts.push(`Contents of ${b.resource.uri}:\n${b.resource.text}`);
  }
  return parts.join("\n").trim();
}

// ── permissions ────────────────────────────────────────────────────────────

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

/** The option set offered for every gearbox permission request. optionIds
 *  deliberately mirror gearbox's PermDecision vocabulary. */
export const PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: "once", name: "Allow once", kind: "allow_once" },
  { optionId: "always", name: "Always allow", kind: "allow_always" },
  { optionId: "deny", name: "Reject", kind: "reject_once" },
];

/** Map the client's permission outcome back to gearbox's PermDecision. */
export function outcomeToDecision(outcome: { outcome: string; optionId?: string } | undefined): "once" | "always" | "deny" {
  if (!outcome || outcome.outcome !== "selected") return "deny"; // cancelled → deny
  if (outcome.optionId === "once" || outcome.optionId === "always") return outcome.optionId;
  return "deny";
}

// ── initialize ─────────────────────────────────────────────────────────────

export function initializeResult(version: string): unknown {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: true, // persisted gearbox sessions replay into the editor
      promptCapabilities: { image: false, audio: false, embeddedContext: true },
      mcpCapabilities: { http: false, sse: false },
    },
    agentInfo: { name: "gearbox", title: "Gearbox", version },
    authMethods: [],
  };
}
