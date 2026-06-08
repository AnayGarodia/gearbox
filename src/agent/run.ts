// The real agent loop: AI SDK streamText → normalized AgentEvents.
// Parsing is defensive (reads multiple field names) so SDK version drift can't
// silently break text/tool rendering.
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
  // Generic fallback: join SCALAR values only — never stringify a nested object/
  // array (that yields the useless "[object Object]").
  return Object.values(input)
    .filter((v) => v != null && typeof v !== "object")
    .map(String)
    .join(" ")
    .slice(0, 60);
};

// Which JSON field of each tool's input is worth STREAMING as content (so the
// user watches a file get written instead of seeing it dumped at once). The
// "head" field is the short label shown next to the tool (path / command).
const CONTENT_FIELD: Record<string, string> = { write_file: "content", edit_file: "replace" };
const HEAD_FIELD: Record<string, string> = { run_shell: "command" }; // default: "path"

// Tools that render their OWN rich progress via onEvent (the delegate sub-agent
// lines, the merge summary). The generic tool lifecycle below would double-render
// them — once with a garbage `[object Object]` head from their array input — so we
// skip our UI for these and let the tool drive the display.
const SELF_RENDERING = new Set(["delegate", "delegate_parallel"]);

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

// "model/deployment does not exist" is opaque on ANY provider: the id you called
// isn't actually served by your account (Azure deployment names, a retired gateway
// model, a Bedrock model you haven't enabled, …). Rewrite it into one actionable
// line, naming the id that failed and pointing at discovery. Native providers have
// a stable, curated id set, so we leave their errors untouched.
const NATIVE_PROVIDERS = new Set(["anthropic", "openai", "google", "deepseek"]);
const MODEL_NOT_SERVED = /does not exist|not found|no such model|model_not_found|unknown model|invalid model|deployment.*(does not exist|not)|resource not found/i;

export function unavailableModelHint(message: string, model: ModelSpec): string {
  if (NATIVE_PROVIDERS.has(model.provider)) return message;
  if (MODEL_NOT_SERVED.test(message)) {
    return `“${model.sdkId}” isn't available on your ${model.provider} account. Run /account refresh to see what is, then /model <name>. (${message})`;
  }
  return message;
}

// Truncate at a word boundary with an ellipsis, so a preview never cuts mid-word
// ("…purpose; the ro") and the trailing count doesn't collide with a severed word.
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
  effort?: Effort; // model-specific reasoning effort → per-provider providerOptions
  deferTerminal?: boolean; // suppress terminal error/blocked/finished/done events + return `failure` instead (the caller drives failover and emits the final outcome)
  depth?: number; // 0 = top-level turn (gets the `delegate` tool); >0 = a sub-agent (no delegate, so delegation can't recurse)
  root?: string; // workspace root for file/shell tools (a parallel sub-agent gets its own git worktree)
  maxRetries?: number; // SDK retry budget; the caller drops this to 0 when offline so a no-network turn fails in one connect-timeout instead of the ~30s 3-attempt storm
  pinnedModelId?: string; // when the user EXPLICITLY chose a model (a /model pin or "use opus"), delegated sub-tasks inherit it instead of re-routing to the cheapest
  cacheBreak?: number; // index of the last settled-history message (from the context engine) → cache that prefix; the volatile turn-context tail rides after it
  _stream?: AsyncIterable<any>; // test seam: feed a simulated SDK fullStream
}): Promise<{ messages: ModelMessage[]; usage: Usage; headers?: Record<string, string | undefined>; failure?: { message: string; raw: unknown; producedOutput: boolean } }> {
  const { model, messages, onEvent, signal, plan } = opts;
  const depth = opts.depth ?? 0;
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let failureMessage: string | undefined;
  const providerOptions = opts.effort ? reasoningOptions(model, opts.effort) : {};

  // One clean, one-line error path. The AI SDK surfaces errors three ways
  // (an `error` stream part, a thrown iterator error, and — if unhandled — a
  // rejected internal promise that Bun would dump RAW to the screen). `onError`
  // catches that third case; `emitErr` dedupes + trims so the UI shows a single
  // readable line, never the giant APICallError object.
  let errored = false;
  let producedOutput = false;
  let failureRaw: unknown = undefined;
  const emitErr = (err: unknown) => {
    if (errored || signal?.aborted) return;
    errored = true;
    failureMessage = cleanError(err);
    failureRaw = err;
    // When the caller drives failover (deferTerminal), stay silent and hand back
    // `failure` — a single red error line is wrong if the next account succeeds.
    if (!opts.deferTerminal) onEvent({ type: "error", message: unavailableModelHint(failureMessage, model) });
  };

  onEvent({ type: "phase", label: "contacting model", detail: model.label, state: "running" });
  // Delegation (top-level turns only, and not in plan mode): the `delegate` tool
  // spawns a sub-agent on a freshly-routed model. The sub-agent IS another runTask
  // at depth+1 (so it has no delegate tool — no recursion). We capture its prose as
  // the tool result and forward only its sub-events upward (handled by the tool).
  const subRunner: SubAgentRunner = async (p) => {
    let text = "";
    const wrapped: OnEvent = (e) => { if (e.type === "text") text += e.text; else p.onEvent(e); };
    const sr = await runTask({ model: p.model, creds: p.creds, system: p.system, messages: [{ role: "user", content: p.prompt }], onEvent: wrapped, signal: p.signal, depth: depth + 1, deferTerminal: true, root: p.root, maxRetries: opts.maxRetries });
    return { text, usage: sr.usage, failure: sr.failure ? { message: sr.failure.message } : undefined };
  };
  const extraTools = depth === 0 && !plan ? makeDelegateTools({ onEvent, signal, run: subRunner, pinnedModelId: opts.pinnedModelId }) : undefined;
  const activeTools = await createToolset(onEvent, { readOnly: Boolean(plan), extraTools, root: opts.root });
  // Prompt caching: mark the stable prefix (tools+system+settled history) so a
  // provider with explicit breakpoints reuses it cheaply next turn. No-op on
  // providers that cache automatically (OpenAI/DeepSeek/Gemini).
  const cached = withPromptCaching(model, opts.system ?? (plan ? SYSTEM + PLAN_ADDENDUM : SYSTEM), messages, opts.cacheBreak);
  const result = opts._stream
    ? null
    : streamText({
        model: resolveModel(model, opts.creds),
        system: cached.system,
        messages: cached.messages,
        // We deliberately move the (trusted, our-own) system prompt into messages
        // so a cache marker can ride on it; opt in so the SDK doesn't warn about
        // system-in-messages (that guard is for UNTRUSTED injected system text).
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
  // Per-tool-call streaming state: the head label (path/command) is read in full
  // from the growing buffer; the content field (file body) is decoded incrementally.
  type ToolStream = { name: string; rawBuf: string; headField: string; lastHead: string; content: FieldStreamer | null; pending: string };
  const streams = new Map<string, ToolStream>();
  const started = new Set<string>();
  const selfRender = new Set<string>(); // call ids of self-rendering tools (delegate*) — we skip our generic UI for them
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
          if (t) { producedOutput = true; onEvent({ type: "text", text: t }); await maybePaint(); }
          break;
        }
        case "tool-input-start": {
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
          const st = streams.get(id) ?? openStream(id, names.get(id) ?? "tool");
          if (!started.has(id)) { started.add(id); producedOutput = true; onEvent({ type: "tool-start", id, name: st.name, arg: "" }); }
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
          if (SELF_RENDERING.has(name)) { selfRender.add(id); started.add(id); producedOutput = true; break; } // the tool drives its own UI
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
            producedOutput = true;
            onEvent({ type: "tool-start", id, name, arg });
            onEvent({ type: "phase", label: friendlyToolPhase(name), detail: arg, state: "running" });
          }
          break;
        }
        case "tool-result": {
          const id = part.toolCallId ?? part.id ?? "";
          if (selfRender.has(id)) break; // delegate tools already emitted their own end
          const output = part.output ?? part.result;
          if (output && typeof output === "object" && Array.isArray(output.diff)) {
            onEvent({ type: "tool-end", id, ok: true, summary: String(output.summary ?? "done"), diff: output.diff });
          } else {
            onEvent({ type: "tool-end", id, ok: true, summary: resultSummary(output) });
          }
          // No "tool finished" phase — the tool's own result line says it finished.
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
          // Cache WRITES are Anthropic-specific and reported per step (not on the
          // final `finish`) — accumulate them so the turn's total is complete.
          const cc = (part as any).providerMetadata?.anthropic?.cacheCreationInputTokens;
          if (typeof cc === "number" && cc > 0) usage.cacheCreationInputTokens = (usage.cacheCreationInputTokens ?? 0) + cc;
          break;
        }
        case "finish": {
          const u = part.totalUsage ?? part.usage ?? {};
          usage.inputTokens = u.inputTokens ?? u.promptTokens ?? 0;
          usage.outputTokens = u.outputTokens ?? u.completionTokens ?? 0;
          // Cache READS (the hit) are the universal signal — every provider that
          // caches surfaces them here (Anthropic cache_read, OpenAI/DeepSeek cached).
          if (typeof u.cachedInputTokens === "number" && u.cachedInputTokens > 0) usage.cachedInputTokens = u.cachedInputTokens;
          break;
        }
      }
    }
  } catch (e: any) {
    // On a user interrupt the App shows its own "interrupted" notice — stay quiet.
    if (!signal?.aborted) emitErr(e);
  }

  let next = messages;
  let headers: Record<string, string | undefined> | undefined;
  if (result) {
    try {
      const resp = await result.response;
      next = [...messages, ...(resp.messages as ModelMessage[])];
      // Response rate-limit headers — the router reads these to estimate live API
      // headroom (parsed by the caller, who knows the account/provider).
      headers = (resp as any).headers as Record<string, string | undefined> | undefined;
    } catch {
      /* keep prior messages; multi-turn still works from input history */
    }
  }
  const failure = errored ? { message: failureMessage ?? cleanError(failureRaw), raw: failureRaw, producedOutput } : undefined;
  if (!opts.deferTerminal) {
    if (errored) onEvent({ type: "phase", label: "blocked", state: "err" }); // no "finished" phase — the assistant reply is the signal
    onEvent({ type: "done", usage });
  }
  return { messages: next, usage, headers, failure };
}

// A single, tool-less completion through the same provider seam as runTask —
// used for grounded Q&A (e.g. /ask over the bundled docs) where the model should
// answer from the system prompt, never call tools or loop. Emits the same text/
// finish/done events so the UI's streaming render + usage capture work unchanged.
export async function runCompletion(opts: {
  model: ModelSpec;
  system: string;
  prompt: string;
  onEvent: OnEvent;
  signal?: AbortSignal;
  creds?: ResolvedCreds;
  effort?: Effort;
  maxRetries?: number; // 0 when offline → fail fast instead of the retry storm
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
        allowSystemInMessages: true, // our own system prompt, moved into messages to carry the cache marker
        abortSignal: signal,
        maxRetries: opts.maxRetries,
        onError: ({ error }) => emitErr(error),
        ...(Object.keys(providerOptions).length ? { providerOptions: providerOptions as any } : {}),
      });
  const parts: AsyncIterable<any> = opts._stream ?? (result!.fullStream as AsyncIterable<any>);

  let text = "";
  // Yield to the event loop between deltas so Ink actually repaints AND the App's
  // 45ms text-coalesce timer can fire mid-stream — otherwise the whole answer
  // arrives on back-to-back microtasks and paints in one dump (the /ask "not
  // streamed" bug). Mirrors runTask's maybePaint.
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
  if (errored) onEvent({ type: "phase", label: "blocked", state: "err" }); // no "finished" phase — the assistant reply is the signal
  onEvent({ type: "done", usage });
  return { text, usage };
}

function friendlyToolPhase(name: string): string {
  if (name === "read_file" || name === "list_dir" || name === "glob" || name === "search") return "reading context";
  if (name === "write_file" || name === "edit_file") return "editing files";
  if (name === "run_shell") return "running command";
  return "using tool";
}
