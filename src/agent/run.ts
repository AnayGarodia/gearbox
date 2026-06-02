// The real agent loop: AI SDK streamText → normalized AgentEvents.
// Parsing is defensive (reads multiple field names) so SDK version drift can't
// silently break text/tool rendering.
import { streamText, stepCountIs, type ModelMessage } from "ai";
import { resolveModel, type ModelSpec } from "../providers.ts";
import { tools, readOnlyTools } from "../tools.ts";
import { config } from "../config.ts";
import type { OnEvent, Usage } from "./events.ts";

const PLAN_ADDENDUM = `

# PLAN MODE (read-only)
You are in read-only plan mode. Investigate using read-only tools only, then
produce a concise, numbered plan for the change. DO NOT modify files or run
commands. End by noting you're ready to implement once the user approves.`;

const SYSTEM = `You are Gearbox, a precise terminal coding agent.
Work in small, verifiable steps. Use the tools to read before you write, and
run tests or commands to check your work rather than assuming. Prefer the
smallest change that solves the problem. Be concise in prose; let the diffs and
test output speak. When done, say briefly what you changed and how you verified it.`;

const argSummary = (name: string, input: any): string => {
  if (!input || typeof input !== "object") return "";
  if (name === "run_shell") return String(input.command ?? "");
  if ("path" in input) return String(input.path);
  return Object.values(input).map(String).join(" ").slice(0, 60);
};

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
}): Promise<{ messages: ModelMessage[]; usage: Usage }> {
  const { model, messages, onEvent, signal, plan } = opts;
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };

  const result = streamText({
    model: resolveModel(model),
    system: plan ? SYSTEM + PLAN_ADDENDUM : SYSTEM,
    messages,
    tools: plan ? readOnlyTools : tools,
    stopWhen: stepCountIs(config.maxSteps),
    abortSignal: signal,
  });

  const names = new Map<string, string>();
  try {
    for await (const part of result.fullStream as AsyncIterable<any>) {
      switch (part.type) {
        case "text-delta": {
          const t = part.text ?? part.textDelta ?? "";
          if (t) onEvent({ type: "text", text: t });
          break;
        }
        case "tool-call": {
          const id = part.toolCallId ?? part.id ?? String(names.size);
          const name = part.toolName ?? part.name ?? "tool";
          names.set(id, name);
          onEvent({ type: "tool-start", id, name, arg: argSummary(name, part.input ?? part.args) });
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
          break;
        }
        case "tool-error": {
          const id = part.toolCallId ?? part.id ?? "";
          onEvent({ type: "tool-end", id, ok: false, summary: String(part.error ?? "failed").slice(0, 64) });
          break;
        }
        case "error": {
          onEvent({ type: "error", message: String(part.error ?? "unknown error") });
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
    if (!signal?.aborted) onEvent({ type: "error", message: e?.message ?? String(e) });
  }

  let next = messages;
  try {
    const resp = await result.response;
    next = [...messages, ...(resp.messages as ModelMessage[])];
  } catch {
    /* keep prior messages; multi-turn still works from input history */
  }
  onEvent({ type: "done", usage });
  return { messages: next, usage };
}
