/**
 * Core agent loop: drives the AI SDK's `streamText` call and translates its
 * raw stream parts into normalized AgentEvents for the UI.
 *
 * Responsibilities:
 *   - Build the streamText call (model, system, messages, tools, provider
 *     options) from the options passed by the orchestrator.
 *   - Consume the fullStream, mapping each SDK part type to one or more
 *     AgentEvents (text-delta, tool-input-start/delta/call/result, finish, ...).
 *   - Incrementally decode streaming tool inputs so the UI can show the file
 *     path and content live, not as a single dump when the call is complete.
 *   - Handle abort/interrupt signals: the AbortSignal flows into the SDK and
 *     also short-circuits the local error handler so no spurious error event
 *     fires when the user cancels.
 *   - Accumulate usage tokens across steps (Anthropic reports cache writes per
 *     step) and normalize field names across provider variants.
 *   - Support depth-based tool scoping: the top-level turn (depth 0) gets the
 *     delegate tools; sub-agents (depth > 0) do not, preventing recursion.
 *
 * The module never imports from the UI layer. Events flow outward via the
 * OnEvent callback, keeping the pipeline decoupled from rendering.
 *
 * runCompletion is a simpler, tool-less path used for grounded Q&A (/ask).
 */
import { streamText, stepCountIs, type ModelMessage } from "ai";
import { resolveModel, type ModelSpec } from "../providers.ts";
import type { ResolvedCreds } from "../accounts/types.ts";
import { reasoningOptions, type Effort } from "../model/reasoning.ts";
import { withPromptCaching } from "../model/caching.ts";
import { makeDelegateTools, type SubAgentRunner } from "./delegate.ts";
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
  // Generic fallback: join SCALAR values only, never stringify a nested object
  // or array (that yields the useless "[object Object]").
  return Object.values(input)
    .filter((v) => v != null && typeof v !== "object")
    .map(String)
    .join(" ")
    .slice(0, 60);
};

// Stream the body of write_file/edit_file so the user watches the file arrive
// instead of seeing it dumped at once. HEAD_FIELD overrides the default "path"
// label shown in the tool head (run_shell shows its command instead).
const CONTENT_FIELD: Record<string, string> = { write_file: "content", edit_file: "replace" };
const HEAD_FIELD: Record<string, string> = { run_shell: "command" };

// delegate/delegate_parallel emit their own structured events, so the generic
// tool lifecycle would double-render them (with a useless "[object Object]" head
// from the array input). Skip our UI and let the tool drive its own display.
const SELF_RENDERING = new Set(["delegate", "delegate_parallel"]);

/**
 * Incrementally decodes ONE JSON string field out of a partial JSON buffer as
 * it streams in. The SDK hands us raw `inputTextDelta` chunks of the tool
 * input JSON; this class is stateful so it only decodes newly-arrived bytes
 * and returns the freshly decoded characters on each push call.
 *
 * It never advances past an incomplete trailing escape sequence (\uXXXX or
 * a backslash at the end of a chunk), so callers always receive valid UTF-16.
 */
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
      // Scan forward to find `"<field>"` in the accumulated buffer, then skip
      // past the colon separator to the opening quote of the string value.
      const k = this.buf.indexOf(`"${this.field}"`);
      if (k < 0) return "";
      let i = k + this.field.length + 2;
      while (i < this.buf.length && /\s/.test(this.buf[i]!)) i++;
      if (this.buf[i] !== ":") return "";
      i++;
      while (i < this.buf.length && /\s/.test(this.buf[i]!)) i++;
      if (this.buf[i] === undefined) return "";
      if (this.buf[i] !== '"') return ""; // value is not a string, or not arrived yet
      this.started = true;
      this.pos = i + 1; // position past the opening quote
    }
    const ESC: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" };
    let out = "";
    let i = this.pos;
    while (i < this.buf.length) {
      const c = this.buf[i]!;
      if (c === '"') { this.done = true; i++; break; } // closing quote, field complete
      if (c === "\\") {
        const n = this.buf[i + 1];
        if (n === undefined) break; // incomplete escape, wait for more data
        if (n === "u") {
          if (i + 6 > this.buf.length) break; // incomplete \uXXXX, wait for more data
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

/**
 * Decodes a short string field in full from a (possibly partial) JSON buffer.
 * Used for the head label (path/command), which is short and arrives early in
 * the stream. Returns null if the field is not yet present or complete.
 */
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

// Extract a short, human-readable line from any error shape the AI SDK or the
// underlying fetch layer might throw: APICallError, plain Error, string, or a
// raw object. Never returns the full stack or the full response body.
function cleanError(err: any): string {
  const raw = err?.message ?? err?.error?.message ?? err?.responseBody ?? (typeof err === "string" ? err : "");
  const msg = String(raw || "request failed").split("\n")[0]!.trim();
  return msg.length > 240 ? msg.slice(0, 240) + "…" : msg;
}

// "model/deployment does not exist" is opaque on gateway and cloud providers:
// the id you called is not actually served by your account (Azure deployment
// names, a retired gateway model, a Bedrock model you haven't enabled, etc.).
// Rewrite it into one actionable line naming the id that failed and pointing at
// discovery. Native providers have a stable, curated id set, so their errors
// are left untouched.
const NATIVE_PROVIDERS = new Set(["anthropic", "openai", "google", "deepseek"]);
const MODEL_NOT_SERVED = /does not exist|not found|no such model|model_not_found|unknown model|invalid model|deployment.*(does not exist|not)|resource not found/i;

export function unavailableModelHint(message: string, model: ModelSpec): string {
  if (NATIVE_PROVIDERS.has(model.provider)) return message;
  if (MODEL_NOT_SERVED.test(message)) {
    return `"${model.sdkId}" isn't available on your ${model.provider} account. Run /account refresh to see what is, then /model <name>. (${message})`;
  }
  return message;
}

// Truncate at a word boundary with an ellipsis so a preview never cuts
// mid-word, and the trailing count doesn't collide with a severed word.
const truncWord = (s: string, max: number): string => {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return (at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,.;:]+$/, "") + "…";
};

const resultSummary = (out: any): string => {
  const s = typeof out === "string" ? out : JSON.stringify(out);
  const first = s.split("\n").find((l) => l.trim()) ?? "";
  const lines = s.split("\n").length;
  return lines > 1 ? `${truncWord(first, 56)} · ${lines} lines` : truncWord(first, 64);
};

export async function runTask(opts: {
  model: ModelSpec;
  messages: ModelMessage[];
  onEvent: OnEvent;
  signal?: AbortSignal;
  plan?: boolean;
  system?: string; // prebuilt by the Context Engine; falls back to SYSTEM
  creds?: ResolvedCreds; // per-account credentials (from the active account); env-default if absent
  effort?: Effort; // model-specific reasoning effort, maps to per-provider providerOptions
  deferTerminal?: boolean; // suppress terminal error/blocked/finished/done events and return `failure` instead (the caller drives failover and emits the final outcome)
  depth?: number; // 0 = top-level turn (gets the delegate tool); >0 = sub-agent (no delegate tool, no recursion)
  root?: string; // workspace root for file/shell tools (a parallel sub-agent gets its own git worktree)
  maxRetries?: number; // SDK retry budget; set to 0 when offline so a no-network turn fails in one connect-timeout instead of the default 3-attempt storm
  pinnedModelId?: string; // when the user explicitly chose a model (via /model or "use opus"), delegated sub-tasks inherit it instead of re-routing to the cheapest
  cacheBreak?: number; // index of the last settled-history message (from the context engine), cache that prefix; the volatile turn-context tail rides after it
  _stream?: AsyncIterable<any>; // test seam: feed a simulated SDK fullStream
}): Promise<{ messages: ModelMessage[]; usage: Usage; headers?: Record<string, string | undefined>; failure?: { message: string; raw: unknown; producedOutput: boolean } }> {
  const { model, messages, onEvent, signal, plan } = opts;
  const depth = opts.depth ?? 0;
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let failureMessage: string | undefined;
  const providerOptions = opts.effort ? reasoningOptions(model, opts.effort) : {};

  // The AI SDK surfaces errors through three paths: an `error` stream part, a
  // thrown iterator error, and an unhandled rejected promise (Bun dumps that
  // raw). `onError` in the streamText call catches the third path. `emitErr`
  // deduplicates all three paths so the UI always shows a single readable line,
  // never the full APICallError object.
  //
  // Abort/interrupt short-circuit: when the user presses Ctrl-C, the
  // AbortSignal fires. The SDK throws a DOMException("AbortError") through the
  // stream iterator, which would otherwise look like a network error. We check
  // `signal?.aborted` first in emitErr and in the catch block to stay silent,
  // since the App already shows its own "interrupted" notice in that case.
  let errored = false;
  let producedOutput = false;
  let failureRaw: unknown = undefined;
  const emitErr = (err: unknown) => {
    // Skip if we already reported an error, or if this is an expected abort.
    if (errored || signal?.aborted) return;
    errored = true;
    failureMessage = cleanError(err);
    failureRaw = err;
    // When the caller drives failover (deferTerminal true), stay silent and
    // hand back the `failure` descriptor. Emitting a red error line here would
    // be wrong if the next account in the pool succeeds.
    if (!opts.deferTerminal) onEvent({ type: "error", message: unavailableModelHint(failureMessage, model) });
  };

  onEvent({ type: "phase", label: "contacting model", detail: model.label, state: "running" });

  // Delegation is only available at depth 0 (and not in plan/read-only mode).
  // The injected subRunner calls runTask at depth+1, so the sub-agent receives
  // no delegate tool and cannot spawn further sub-agents. Its prose is captured
  // as the tool result; its non-text events (tool-start/end, phase, etc.) are
  // forwarded directly upward to the parent's onEvent so the UI can show them.
  const subRunner: SubAgentRunner = async (p) => {
    let text = "";
    const wrapped: OnEvent = (e) => { if (e.type === "text") text += e.text; else p.onEvent(e); };
    const sr = await runTask({ model: p.model, creds: p.creds, system: p.system, messages: [{ role: "user", content: p.prompt }], onEvent: wrapped, signal: p.signal, depth: depth + 1, deferTerminal: true, root: p.root, maxRetries: opts.maxRetries });
    return { text, usage: sr.usage, failure: sr.failure ? { message: sr.failure.message } : undefined };
  };
  const extraTools = depth === 0 && !plan ? makeDelegateTools({ onEvent, signal, run: subRunner, pinnedModelId: opts.pinnedModelId }) : undefined;
  const activeTools = await createToolset(onEvent, { readOnly: Boolean(plan), extraTools, root: opts.root });

  // Mark the stable prefix for prompt caching. Providers with explicit cache
  // breakpoints (Anthropic) reuse it at roughly 10% cost; auto-caching providers
  // (OpenAI/DeepSeek/Gemini) ignore the markers harmlessly.
  const cached = withPromptCaching(model, opts.system ?? (plan ? SYSTEM + PLAN_ADDENDUM : SYSTEM), messages, opts.cacheBreak);
  const result = opts._stream
    ? null
    : streamText({
        model: resolveModel(model, opts.creds),
        system: cached.system,
        messages: cached.messages,
        // allowSystemInMessages: our own system prompt is moved into the
        // messages array so a cache marker can ride on it. The SDK warning
        // this suppresses targets untrusted injected content, not our own
        // system block.
        allowSystemInMessages: true,
        tools: activeTools,
        stopWhen: stepCountIs(config.maxSteps),
        abortSignal: signal,
        maxRetries: opts.maxRetries,
        onError: ({ error }) => emitErr(error),
        ...(Object.keys(providerOptions).length ? { providerOptions: providerOptions as any } : {}),
      });
  const parts: AsyncIterable<any> = opts._stream ?? (result!.fullStream as AsyncIterable<any>);

  const names = new Map<string, string>();
  // Per-tool-call streaming state: the head label (path/command) is read in
  // full from the growing raw buffer; the content field (file body) is decoded
  // incrementally via FieldStreamer so lines can be flushed as they arrive.
  type ToolStream = { name: string; rawBuf: string; headField: string; lastHead: string; content: FieldStreamer | null; pending: string };
  const streams = new Map<string, ToolStream>();
  const started = new Set<string>();
  // Call IDs for delegate/delegate_parallel: these tools emit their own events,
  // so we skip the generic tool-start/end rendering for them entirely.
  const selfRender = new Set<string>();
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

  // Flush whole completed lines from the pending buffer. Coalescing per line
  // (not per token) reduces UI update frequency. `final` flushes the remaining
  // partial line when the input stream ends. Returns true if anything was emitted.
  const flush = (id: string, st: ToolStream, final: boolean): boolean => {
    const cut = final ? st.pending.length : st.pending.lastIndexOf("\n") + 1;
    if (cut <= 0) return false;
    onEvent({ type: "tool-stream", id, delta: st.pending.slice(0, cut) });
    st.pending = st.pending.slice(cut);
    return true;
  };

  // The model delivers text/tool-input in network bursts: dozens of deltas land
  // back-to-back on microtasks, and Ink only repaints on a macrotask turn.
  // Without yielding here, the whole burst would paint as a single dump.
  // Capping at roughly 60 fps (16 ms) makes content appear to stream live.
  // The injected test stream skips this because there is no terminal to paint.
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
          if (t) { producedOutput = true; onEvent({ type: "text", text: t }); await maybePaint(); }
          break;
        }
        case "tool-input-start": {
          // The SDK fires this as soon as the tool name is known, before any
          // input JSON has arrived. Open a stream state slot and emit tool-start
          // immediately so the UI can render the item header right away.
          const id = part.toolCallId ?? part.id ?? String(names.size);
          const name = part.toolName ?? part.name ?? "tool";
          names.set(id, name);
          started.add(id);
          producedOutput = true;
          if (SELF_RENDERING.has(name)) { selfRender.add(id); break; } // the tool drives its own UI
          openStream(id, name);
          onEvent({ type: "tool-start", id, name, arg: "" });
          onEvent({ type: "phase", label: friendlyToolPhase(name), state: "running" });
          break;
        }
        case "tool-input-delta": {
          const id = part.toolCallId ?? part.id ?? "";
          if (selfRender.has(id)) break;
          const chunk = part.inputTextDelta ?? part.delta ?? "";
          if (!chunk) break;
          // Some providers (e.g. older OpenAI compat endpoints) skip
          // tool-input-start and go straight to delta; handle that gracefully.
          const st = streams.get(id) ?? openStream(id, names.get(id) ?? "tool");
          if (!started.has(id)) { started.add(id); producedOutput = true; onEvent({ type: "tool-start", id, name: st.name, arg: "" }); }
          st.rawBuf += chunk;
          // Attempt to decode the head label (path/command) on every delta.
          // Once it changes from the last emitted value, push an arg update.
          const head = readField(st.rawBuf, st.headField);
          if (head != null && head !== st.lastHead) { st.lastHead = head; onEvent({ type: "tool-stream", id, arg: head }); }
          // Incrementally decode and buffer the content field; flush whole lines.
          if (st.content) {
            st.pending += st.content.push(chunk);
            if (flush(id, st, false)) await maybePaint();
          }
          break;
        }
        case "tool-call": {
          // Final, complete tool call (either after streaming deltas, or as a
          // single event from providers that do not stream tool inputs).
          const id = part.toolCallId ?? part.id ?? String(names.size);
          const name = part.toolName ?? part.name ?? "tool";
          names.set(id, name);
          if (SELF_RENDERING.has(name)) { selfRender.add(id); started.add(id); producedOutput = true; break; }
          const arg = argSummary(name, part.input ?? part.args);
          // If the input already streamed, just finalize: flush the last
          // partial line and update the head arg. If it did not stream (the
          // provider sent only the complete call), create the item from scratch.
          const st = streams.get(id);
          if (started.has(id)) {
            if (st) flush(id, st, true);
            onEvent({ type: "tool-stream", id, arg });
          } else {
            started.add(id);
            producedOutput = true;
            onEvent({ type: "tool-start", id, name, arg });
            onEvent({ type: "phase", label: friendlyToolPhase(name), detail: arg, state: "running" });
          }
          break;
        }
        case "tool-result": {
          const id = part.toolCallId ?? part.id ?? "";
          if (selfRender.has(id)) break; // self-rendering tools emit their own end events
          const output = part.output ?? part.result;
          // Tools that return a structured diff (write_file, edit_file) include
          // a `diff` array so the UI can render a line-level diff inline.
          if (output && typeof output === "object" && Array.isArray(output.diff)) {
            onEvent({ type: "tool-end", id, ok: true, summary: String(output.summary ?? "done"), diff: output.diff });
          } else {
            onEvent({ type: "tool-end", id, ok: true, summary: resultSummary(output) });
          }
          break;
        }
        case "tool-error": {
          const id = part.toolCallId ?? part.id ?? "";
          if (selfRender.has(id)) break; // delegate tools report their own failures
          onEvent({ type: "tool-end", id, ok: false, summary: String(part.error ?? "failed").slice(0, 64) });
          onEvent({ type: "phase", label: "tool failed", state: "err" });
          break;
        }
        case "error": {
          emitErr(part.error);
          break;
        }
        case "finish-step": {
          // Anthropic reports cache WRITE tokens per step, not on the final
          // finish event. Accumulate here so the turn total is complete.
          const cc = (part as any).providerMetadata?.anthropic?.cacheCreationInputTokens;
          if (typeof cc === "number" && cc > 0) usage.cacheCreationInputTokens = (usage.cacheCreationInputTokens ?? 0) + cc;
          break;
        }
        case "finish": {
          // Normalize token counts across provider field name variants.
          const u = part.totalUsage ?? part.usage ?? {};
          usage.inputTokens = u.inputTokens ?? u.promptTokens ?? 0;
          usage.outputTokens = u.outputTokens ?? u.completionTokens ?? 0;
          // Cache READ tokens (the hit) are the universal signal: every provider
          // that caches surfaces them here (Anthropic cache_read,
          // OpenAI/DeepSeek cached_tokens).
          if (typeof u.cachedInputTokens === "number" && u.cachedInputTokens > 0) usage.cachedInputTokens = u.cachedInputTokens;
          break;
        }
      }
    }
  } catch (e: any) {
    // On a user interrupt the App shows its own "interrupted" notice, so stay
    // quiet. Any other thrown error is a real failure and should be reported.
    if (!signal?.aborted) emitErr(e);
  }

  let next = messages;
  let headers: Record<string, string | undefined> | undefined;
  if (result) {
    try {
      const resp = await result.response;
      next = [...messages, ...(resp.messages as ModelMessage[])];
      // Rate-limit response headers: the router reads these to estimate live
      // API headroom for the account/provider (parsed by the caller).
      headers = (resp as any).headers as Record<string, string | undefined> | undefined;
    } catch {
      /* keep prior messages; multi-turn still works from input history */
    }
  }
  const failure = errored ? { message: failureMessage ?? cleanError(failureRaw), raw: failureRaw, producedOutput } : undefined;
  if (!opts.deferTerminal) {
    // A "blocked" phase (no "finished") signals the turn failed. The assistant
    // reply itself is the UI signal for a successful turn, not a phase event.
    if (errored) onEvent({ type: "phase", label: "blocked", state: "err" });
    onEvent({ type: "done", usage });
  }
  return { messages: next, usage, headers, failure };
}

/**
 * A single, tool-less completion through the same provider seam as runTask.
 * Used for grounded Q&A (e.g. /ask over the bundled docs) where the model
 * should answer from the system prompt and never call tools or loop.
 *
 * Emits the same text/finish/done events as runTask so the UI's streaming
 * render and usage capture work unchanged.
 */
export async function runCompletion(opts: {
  model: ModelSpec;
  system: string;
  prompt: string;
  onEvent: OnEvent;
  signal?: AbortSignal;
  creds?: ResolvedCreds;
  effort?: Effort;
  maxRetries?: number; // set to 0 when offline to fail fast instead of the 3-attempt retry storm
  _stream?: AsyncIterable<any>; // test seam
}): Promise<{ text: string; usage: Usage }> {
  const { model, system, prompt, onEvent, signal } = opts;
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const providerOptions = opts.effort ? reasoningOptions(model, opts.effort) : {};
  let errored = false;
  const emitErr = (err: unknown) => {
    if (errored || signal?.aborted) return;
    errored = true;
    onEvent({ type: "error", message: unavailableModelHint(cleanError(err), model) });
  };

  onEvent({ type: "phase", label: "contacting model", detail: model.label, state: "running" });
  // Cache the (large, reused) /ask system corpus so repeat questions are cheap.
  const cached = withPromptCaching(model, system, [{ role: "user", content: prompt }]);
  const result = opts._stream
    ? null
    : streamText({
        model: resolveModel(model, opts.creds),
        system: cached.system,
        messages: cached.messages,
        allowSystemInMessages: true, // same reason as runTask: cache marker on our own system block
        abortSignal: signal,
        maxRetries: opts.maxRetries,
        onError: ({ error }) => emitErr(error),
        ...(Object.keys(providerOptions).length ? { providerOptions: providerOptions as any } : {}),
      });
  const parts: AsyncIterable<any> = opts._stream ?? (result!.fullStream as AsyncIterable<any>);

  let text = "";
  // Yield to the event loop between deltas so Ink actually repaints AND the
  // App's 45ms text-coalesce timer can fire mid-stream. Without this yield,
  // the whole answer arrives on back-to-back microtasks and paints in one dump
  // (the /ask "not streamed" bug). Mirrors runTask's maybePaint.
  let lastYield = 0;
  const yieldPaint = async () => {
    if (opts._stream) return;
    const now = Date.now();
    if (now - lastYield < 16) return;
    lastYield = now;
    await new Promise((r) => setTimeout(r, 0));
  };
  try {
    for await (const part of parts) {
      if (part.type === "text-delta") {
        const t = part.text ?? part.textDelta ?? "";
        if (t) { text += t; onEvent({ type: "text", text: t }); await yieldPaint(); }
      } else if (part.type === "error") {
        emitErr(part.error);
      } else if (part.type === "finish") {
        const u = part.totalUsage ?? part.usage ?? {};
        usage.inputTokens = u.inputTokens ?? u.promptTokens ?? 0;
        usage.outputTokens = u.outputTokens ?? u.completionTokens ?? 0;
        if (typeof u.cachedInputTokens === "number" && u.cachedInputTokens > 0) usage.cachedInputTokens = u.cachedInputTokens;
      }
    }
  } catch (e: any) {
    if (!signal?.aborted) emitErr(e);
  }
  // No "finished" phase on success; the streamed text is the UI signal.
  if (errored) onEvent({ type: "phase", label: "blocked", state: "err" });
  onEvent({ type: "done", usage });
  return { text, usage };
}

function friendlyToolPhase(name: string): string {
  if (name === "read_file" || name === "list_dir" || name === "glob" || name === "search") return "reading context";
  if (name === "write_file" || name === "edit_file") return "editing files";
  if (name === "run_shell") return "running command";
  return "using tool";
}
