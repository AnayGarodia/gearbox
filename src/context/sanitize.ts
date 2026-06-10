// Message-integrity repair at the READ seam. Gearbox persists whatever a turn
// left behind (a crash mid-turn leaves a dangling user message; an interrupted
// tool loop leaves tool-calls with no results; a previous provider leaves
// reasoning parts and provider metadata in assistant messages). Rather than
// trusting the write path, every turn's outgoing message array is repaired
// right before it is handed to the model — the same posture mature harnesses
// take (opencode's toModelMessages, Codex's ensure_call_outputs_present).
//
// What it fixes, in order:
//   1. residue   — strip `reasoning` parts from assistant messages (never
//                  replayed cross-provider) and delete providerOptions /
//                  providerMetadata from every message and part. Prompt-cache
//                  breakpoints are NOT lost: src/model/caching.ts re-adds them
//                  AFTER this runs (see runTask's call order).
//   2. empties   — drop messages whose content is an empty string/array
//                  (providers 400 on them).
//   3. pairing   — synthesize a tool-result for any assistant tool-call that
//                  has no matching result ("[tool execution was interrupted]"),
//                  and drop orphaned tool-results with no preceding call.
//   4. merging   — merge consecutive same-role user messages into one (joined
//                  with "\n\n"), which neutralizes the dangling-user-message
//                  corruption that made every later turn fail with a 400.
//
// Pure, idempotent, and defensive: any unexpected shape passes through
// unchanged, and an internal throw returns the input untouched — a sanitizer
// must never be the thing that breaks a turn. Untouched messages keep their
// object identity so callers can re-map indices (see sanitizeWithMap).
import type { ModelMessage } from "ai";

const INTERRUPTED = "[tool execution was interrupted]";

type AnyPart = Record<string, unknown> & { type?: string };
type AnyMessage = { role?: string; content?: unknown; providerOptions?: unknown; providerMetadata?: unknown };

const isEmptyContent = (content: unknown): boolean =>
  content == null || content === "" || (Array.isArray(content) && content.length === 0);

// Strip residue from one message: reasoning parts (assistant only) and
// providerOptions/providerMetadata at the message and part level. Returns the
// SAME object when nothing changed so identity (and index mapping) is stable.
function stripResidue(m: ModelMessage): ModelMessage {
  const msg = m as AnyMessage;
  let changed = false;
  let content = msg.content;
  if (Array.isArray(content)) {
    const parts: AnyPart[] = [];
    for (const p of content as AnyPart[]) {
      if (msg.role === "assistant" && p?.type === "reasoning") { changed = true; continue; }
      if (p && typeof p === "object" && ("providerOptions" in p || "providerMetadata" in p)) {
        const { providerOptions: _po, providerMetadata: _pm, ...rest } = p;
        parts.push(rest as AnyPart);
        changed = true;
      } else {
        parts.push(p);
      }
    }
    if (changed) content = parts;
  }
  const hasMsgResidue = "providerOptions" in msg || "providerMetadata" in msg;
  if (!changed && !hasMsgResidue) return m;
  const { providerOptions: _po, providerMetadata: _pm, ...rest } = msg as Record<string, unknown>;
  return { ...rest, content } as ModelMessage;
}

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as AnyPart[])
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("\n\n");
  }
  return "";
};

const toParts = (content: unknown): AnyPart[] =>
  typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? (content as AnyPart[]) : [];

// Merge two consecutive user messages. Plain string + string joins with a
// blank line; anything carrying parts (images, files) concatenates part arrays
// so no attachment is lost.
function mergeUsers(a: ModelMessage, b: ModelMessage): ModelMessage {
  const ca = (a as AnyMessage).content;
  const cb = (b as AnyMessage).content;
  if (typeof ca === "string" && typeof cb === "string") return { role: "user", content: [ca, cb].filter(Boolean).join("\n\n") };
  return { role: "user", content: [...toParts(ca), ...toParts(cb)] } as unknown as ModelMessage;
}

export interface SanitizeResult {
  messages: ModelMessage[];
  /** sourceIndex[i] = index in the ORIGINAL array this output message derives
   *  from (a merged user message maps to its first constituent; a synthesized
   *  tool message maps to the assistant message it answers). Lets the caller
   *  re-map index-based state — runTask uses it to shift the cacheBreak. */
  sourceIndex: number[];
}

/** Full repair pass with an index map back to the original array. */
export function sanitizeWithMap(messages: ModelMessage[]): SanitizeResult {
  try {
    return sanitizeInner(messages);
  } catch {
    // A sanitizer must never lose the turn: on any unexpected shape, hand the
    // input back untouched and let the provider report whatever it reports.
    return { messages, sourceIndex: messages.map((_, i) => i) };
  }
}

/** The pure repair seam: `sanitizeForProvider(messages)` → repaired messages. */
export function sanitizeForProvider(messages: ModelMessage[]): ModelMessage[] {
  return sanitizeWithMap(messages).messages;
}

function sanitizeInner(messages: ModelMessage[]): SanitizeResult {
  const out: ModelMessage[] = [];
  const src: number[] = [];

  // Tool-call ids awaiting a result from the most recent assistant message,
  // with the toolName needed to synthesize a stand-in result.
  let pending = new Map<string, string>();
  let pendingFrom = -1; // original index of the assistant that opened them

  const flushPending = () => {
    if (!pending.size) return;
    out.push({
      role: "tool",
      content: [...pending].map(([toolCallId, toolName]) => ({
        type: "tool-result" as const,
        toolCallId,
        toolName,
        output: { type: "text" as const, value: INTERRUPTED },
      })),
    } as ModelMessage);
    src.push(pendingFrom);
    pending = new Map();
  };

  for (let i = 0; i < messages.length; i++) {
    const raw = messages[i]!;
    if (!raw || typeof raw !== "object" || typeof (raw as AnyMessage).role !== "string") continue;
    const m = stripResidue(raw);
    const role = (m as AnyMessage).role;
    const content = (m as AnyMessage).content;

    if (role === "tool") {
      // Keep only results that answer an open call; orphans (no preceding
      // call — e.g. the call's assistant message was compacted away) are the
      // exact shape providers reject, so they are dropped.
      // Some OpenAI-compat endpoints send `role:"tool", content:"result text"`
      // (a bare string). Normalize it to a tool-result answering the oldest
      // open call instead of dropping a real result on the floor.
      let parts = Array.isArray(content) ? (content as AnyPart[]) : [];
      let normalized = false;
      if (!parts.length && typeof content === "string" && content && pending.size) {
        const [toolCallId, toolName] = pending.entries().next().value as [string, string];
        parts = [{ type: "tool-result", toolCallId, toolName, output: { type: "text", value: content } }];
        normalized = true;
      }
      const kept = parts.filter((p) => p?.type === "tool-result" && typeof p.toolCallId === "string" && pending.has(p.toolCallId as string));
      for (const p of kept) pending.delete(p.toolCallId as string);
      if (!kept.length) continue;
      out.push((!normalized && kept.length === parts.length ? m : { ...(m as object), content: kept }) as ModelMessage);
      src.push(i);
      continue;
    }

    // Any non-tool message closes the result window: synthesize stand-ins for
    // calls that never got answered (interrupted turn) BEFORE this message.
    flushPending();

    if (isEmptyContent(content)) continue;

    if (role === "user" && out.length && (out[out.length - 1] as AnyMessage).role === "user") {
      // Consecutive user messages (a failed turn left its prompt dangling) —
      // merge instead of letting the provider 400 on back-to-back user roles.
      out[out.length - 1] = mergeUsers(out[out.length - 1]!, m);
      continue; // src keeps the FIRST constituent's index
    }

    out.push(m);
    src.push(i);

    if (role === "assistant" && Array.isArray(content)) {
      for (const p of content as AnyPart[]) {
        if (p?.type === "tool-call" && typeof p.toolCallId === "string") {
          pending.set(p.toolCallId as string, typeof p.toolName === "string" ? (p.toolName as string) : "tool");
        }
      }
      if (pending.size) pendingFrom = i;
    }
  }
  flushPending();
  return { messages: out, sourceIndex: src };
}
