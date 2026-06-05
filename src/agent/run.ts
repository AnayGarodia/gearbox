// The real agent loop: AI SDK streamText → normalized AgentEvents.
// Parsing is defensive (reads multiple field names) so SDK version drift can't
// silently break text/tool rendering.
import { streamText, stepCountIs, type ModelMessage } from "ai";
import { resolveModel, type ModelSpec } from "../providers.ts";
import type { ResolvedCreds } from "../accounts/types.ts";
import { reasoningOptions, type Effort } from "../model/reasoning.ts";
import { createToolset } from "../tools.ts";
import { config } from "../config.ts";
import { BASE_SYSTEM, PLAN_ADDENDUM } from "../context/builder.ts";
import type { OnEvent, Usage } from "./events.ts";

// Fallback prompt when the caller doesn't pass a prebuilt `system`. The Context
// Engine (src/context/builder.ts) normally assembles the system prompt (base +
// plan + project memory + repo map + retrieved code); these are the same base
// pieces so a bare runTask call still behaves correctly.
const SYSTEM = BASE_SYSTEM;

const argSummary = (name: string, input: any): string => {
  if (!input || typeof input !== "object") return "";
  if (name === "run_shell") return String(input.command ?? "");
  if ("path" in input) return String(input.path);
  return Object.values(input).map(String).join(" ").slice(0, 60);
};

// Which JSON field of each tool's input is worth STREAMING as content (so the
// user watches a file get written instead of seeing it dumped at once). The
// "head" field is the short label shown next to the tool (path / command).
const CONTENT_FIELD: Record<string, string> = { write_file: "content", edit_file: "replace" };
const HEAD_FIELD: Record<string, string> = { run_shell: "command" }; // default: "path"

// Incrementally decodes ONE JSON string field out of a partial JSON buffer as it
// streams in (the SDK hands us raw `inputTextDelta` chunks of the tool input).
// Stateful so we only decode newly-arrived bytes — returns the freshly decoded
// characters each call, and never advances past an incomplete trailing escape.
export class FieldStreamer {
  private buf = "";
  private pos = 0;
  private started = false;
  private done = false;
  constructor(private field: string) {}
  push(chunk: string): string {
    this.buf += chunk;
    if (this.done) return "";
    if (!this.started) {
      const k = this.buf.indexOf(`"${this.field}"`);
      if (k < 0) return "";
      let i = k + this.field.length + 2;
      while (i < this.buf.length && /\s/.test(this.buf[i]!)) i++;
      if (this.buf[i] !== ":") return "";
      i++;
      while (i < this.buf.length && /\s/.test(this.buf[i]!)) i++;
      if (this.buf[i] === undefined) return "";
      if (this.buf[i] !== '"') return ""; // value isn't a string / not here yet
      this.started = true;
      this.pos = i + 1;
    }
    const ESC: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" };
    let out = "";
    let i = this.pos;
    while (i < this.buf.length) {
      const c = this.buf[i]!;
      if (c === '"') { this.done = true; i++; break; } // closing quote
      if (c === "\\") {
        const n = this.buf[i + 1];
        if (n === undefined) break; // incomplete escape — wait for more
        if (n === "u") {
          if (i + 6 > this.buf.length) break; // incomplete \uXXXX — wait
          out += String.fromCharCode(parseInt(this.buf.slice(i + 2, i + 6), 16));
          i += 6;
          continue;
        }
        out += ESC[n] ?? n;
        i += 2;
        continue;
      }
      out += c;
      i++;
    }
    this.pos = i;
    return out;
  }
}

// Decode a short string field in full from a (possibly partial) JSON buffer —
// used for the head label (path/command), which is short and arrives early.
export function readField(buf: string, field: string): string | null {
  const k = buf.indexOf(`"${field}"`);
  if (k < 0) return null;
  let i = k + field.length + 2;
  while (i < buf.length && /\s/.test(buf[i]!)) i++;
  if (buf[i] !== ":") return null;
  i++;
  while (i < buf.length && /\s/.test(buf[i]!)) i++;
  if (buf[i] !== '"') return null;
  i++;
  let out = "";
  while (i < buf.length) {
    const c = buf[i]!;
    if (c === '"') break;
    if (c === "\\") {
      const n = buf[i + 1];
      if (n === undefined) break;
      const ESC: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", "/": "/" };
      out += ESC[n] ?? n;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Pull a short, human line out of any error (AI SDK APICallError, plain Error,
// string, or object) — never the full object/stack.
function cleanError(err: any): string {
  const raw = err?.message ?? err?.error?.message ?? err?.responseBody ?? (typeof err === "string" ? err : "");
  const msg = String(raw || "request failed").split("\n")[0]!.trim();
  return msg.length > 240 ? msg.slice(0, 240) + "…" : msg;
}

const resultSummary = (out: any): string => {
  const s = typeof out === "string" ? out : JSON.stringify(out);
  const first = s.split("\n").find((l) => l.trim()) ?? "";
  const lines = s.split("\n").length;
  return lines > 1 ? `${first.slice(0, 56)} · ${lines} lines` : first.slice(0, 64);
};

export async function runTask(opts: {
  model: ModelSpec;
  messages: ModelMessage[];
  onEvent: OnEvent;
  signal?: AbortSignal;
  plan?: boolean;
  system?: string; // prebuilt by the Context Engine; falls back to SYSTEM
  creds?: ResolvedCreds; // per-account credentials (from the active account); env-default if absent
  effort?: Effort; // model-specific reasoning effort → per-provider providerOptions
  _stream?: AsyncIterable<any>; // test seam: feed a simulated SDK fullStream
}): Promise<{ messages: ModelMessage[]; usage: Usage }> {
  const { model, messages, onEvent, signal, plan } = opts;
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const providerOptions = opts.effort ? reasoningOptions(model, opts.effort) : {};

  // One clean, one-line error path. The AI SDK surfaces errors three ways
  // (an `error` stream part, a thrown iterator error, and — if unhandled — a
  // rejected internal promise that Bun would dump RAW to the screen). `onError`
  // catches that third case; `emitErr` dedupes + trims so the UI shows a single
  // readable line, never the giant APICallError object.
  let errored = false;
  const emitErr = (err: unknown) => {
    if (errored || signal?.aborted) return;
    errored = true;
    onEvent({ type: "error", message: cleanError(err) });
  };

  onEvent({ type: "phase", label: "contacting model", detail: model.label, state: "running" });
  const activeTools = await createToolset(onEvent, { readOnly: Boolean(plan) });
  const result = opts._stream
    ? null
    : streamText({
        model: resolveModel(model, opts.creds),
        system: opts.system ?? (plan ? SYSTEM + PLAN_ADDENDUM : SYSTEM),
        messages,
        tools: activeTools,
        stopWhen: stepCountIs(config.maxSteps),
        abortSignal: signal,
        onError: ({ error }) => emitErr(error),
        ...(Object.keys(providerOptions).length ? { providerOptions: providerOptions as any } : {}),
      });
  const parts: AsyncIterable<any> = opts._stream ?? (result!.fullStream as AsyncIterable<any>);

  const names = new Map<string, string>();
  // Per-tool-call streaming state: the head label (path/command) is read in full
  // from the growing buffer; the content field (file body) is decoded incrementally.
  type ToolStream = { name: string; rawBuf: string; headField: string; lastHead: string; content: FieldStreamer | null; pending: string };
  const streams = new Map<string, ToolStream>();
  const started = new Set<string>();
  const openStream = (id: string, name: string): ToolStream => {
    const st: ToolStream = {
      name,
      rawBuf: "",
      headField: HEAD_FIELD[name] ?? "path",
      lastHead: "",
      content: CONTENT_FIELD[name] ? new FieldStreamer(CONTENT_FIELD[name]!) : null,
      pending: "",
    };
    streams.set(id, st);
    return st;
  };
  // Flush whole completed lines (coalesce per line, not per token — fewer UI
  // updates). `final` flushes whatever's left when the input ends. Returns true
  // if anything was emitted.
  const flush = (id: string, st: ToolStream, final: boolean): boolean => {
    const cut = final ? st.pending.length : st.pending.lastIndexOf("\n") + 1;
    if (cut <= 0) return false;
    onEvent({ type: "tool-stream", id, delta: st.pending.slice(0, cut) });
    st.pending = st.pending.slice(cut);
    return true;
  };

  // The model delivers text/tool-input in NETWORK BURSTS — dozens of deltas can
  // land in a few milliseconds, processed back-to-back here on microtasks. Ink
  // (the renderer) only repaints when the event loop gets a macrotask turn, so
  // without yielding it paints once per burst and streaming looks like one dump.
  // Yield at most ~60fps so the UI actually shows content arriving live. Skipped
  // for the injected test stream (no terminal to paint).
  let lastPaint = 0;
  const maybePaint = async () => {
    if (opts._stream) return;
    const now = Date.now();
    if (now - lastPaint < 16) return;
    lastPaint = now;
    await new Promise((r) => setTimeout(r, 0));
  };
  try {
    for await (const part of parts) {
      switch (part.type) {
        case "text-delta": {
          const t = part.text ?? part.textDelta ?? "";
          if (t) { onEvent({ type: "text", text: t }); await maybePaint(); }
          break;
        }
        case "tool-input-start": {
          const id = part.toolCallId ?? part.id ?? String(names.size);
          const name = part.toolName ?? part.name ?? "tool";
          names.set(id, name);
          started.add(id);
          openStream(id, name);
          onEvent({ type: "tool-start", id, name, arg: "" });
          onEvent({ type: "phase", label: friendlyToolPhase(name), state: "running" });
          break;
        }
        case "tool-input-delta": {
          const id = part.toolCallId ?? part.id ?? "";
          const chunk = part.inputTextDelta ?? part.delta ?? "";
          if (!chunk) break;
          const st = streams.get(id) ?? openStream(id, names.get(id) ?? "tool");
          if (!started.has(id)) { started.add(id); onEvent({ type: "tool-start", id, name: st.name, arg: "" }); }
          st.rawBuf += chunk;
          const head = readField(st.rawBuf, st.headField);
          if (head != null && head !== st.lastHead) { st.lastHead = head; onEvent({ type: "tool-stream", id, arg: head }); }
          if (st.content) {
            st.pending += st.content.push(chunk);
            if (flush(id, st, false)) await maybePaint(); // emit completed lines, let the UI paint
          }
          break;
        }
        case "tool-call": {
          const id = part.toolCallId ?? part.id ?? String(names.size);
          const name = part.toolName ?? part.name ?? "tool";
          names.set(id, name);
          const arg = argSummary(name, part.input ?? part.args);
          // If the input streamed, the head is already set — just finalize it and
          // flush any trailing partial line. If it didn't (provider sent only the
          // final call), create the item now.
          const st = streams.get(id);
          if (started.has(id)) {
            if (st) flush(id, st, true);
            onEvent({ type: "tool-stream", id, arg });
          } else {
            started.add(id);
            onEvent({ type: "tool-start", id, name, arg });
            onEvent({ type: "phase", label: friendlyToolPhase(name), detail: arg, state: "running" });
          }
          break;
        }
        case "tool-result": {
          const id = part.toolCallId ?? part.id ?? "";
          const output = part.output ?? part.result;
          if (output && typeof output === "object" && Array.isArray(output.diff)) {
            onEvent({ type: "tool-end", id, ok: true, summary: String(output.summary ?? "done"), diff: output.diff });
          } else {
            onEvent({ type: "tool-end", id, ok: true, summary: resultSummary(output) });
          }
          onEvent({ type: "phase", label: "tool finished", state: "ok" });
          break;
        }
        case "tool-error": {
          const id = part.toolCallId ?? part.id ?? "";
          onEvent({ type: "tool-end", id, ok: false, summary: String(part.error ?? "failed").slice(0, 64) });
          onEvent({ type: "phase", label: "tool failed", state: "err" });
          break;
        }
        case "error": {
          emitErr(part.error);
          break;
        }
        case "finish": {
          const u = part.totalUsage ?? part.usage ?? {};
          usage.inputTokens = u.inputTokens ?? u.promptTokens ?? 0;
          usage.outputTokens = u.outputTokens ?? u.completionTokens ?? 0;
          break;
        }
      }
    }
  } catch (e: any) {
    // On a user interrupt the App shows its own "interrupted" notice — stay quiet.
    if (!signal?.aborted) emitErr(e);
  }

  let next = messages;
  if (result) {
    try {
      const resp = await result.response;
      next = [...messages, ...(resp.messages as ModelMessage[])];
    } catch {
      /* keep prior messages; multi-turn still works from input history */
    }
  }
  onEvent({ type: "phase", label: errored ? "blocked" : "finished", state: errored ? "err" : "ok" });
  onEvent({ type: "done", usage });
  return { messages: next, usage };
}

function friendlyToolPhase(name: string): string {
  if (name === "read_file" || name === "list_dir" || name === "glob" || name === "search") return "reading context";
  if (name === "write_file" || name === "edit_file") return "editing files";
  if (name === "run_shell") return "running command";
  return "using tool";
}
