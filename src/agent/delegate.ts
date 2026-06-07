// Task delegation — the orchestrator hands a self-contained sub-task to a fresh
// sub-agent that runs on the model the router picks as best+cheapest for THAT
// task (any provider — "DeepSeek for code, Haiku for digest" falls out of the
// scorer, no special-casing). The sub-agent has full tools and works in the same
// repo, SEQUENTIALLY (the orchestrator awaits it, so there are no parallel-write
// conflicts), then reports back. Depth-1 only: sub-agents don't get this tool, so
// delegation can't recurse into a runaway.
//
// Wiring note: the actual sub-agent loop (runTask) is INJECTED via `run` so this
// module never imports run.ts — that would be a cycle (run.ts imports this).
import { tool } from "ai";
import { z } from "zod";
import { RoutingSelector, classify } from "../model/router.ts";
import { resolveCreds } from "../accounts/resolve.ts";
import { recordUsage } from "../accounts/usage.ts";
import { estimateCost, type ModelSpec } from "../providers.ts";
import type { ResolvedCreds } from "../accounts/types.ts";
import type { OnEvent, Usage } from "./events.ts";

export type SubAgentRunner = (p: {
  model: ModelSpec;
  creds?: ResolvedCreds;
  system: string;
  prompt: string;
  onEvent: OnEvent;
  signal?: AbortSignal;
}) => Promise<{ text: string; usage: Usage; failure?: { message: string } }>;

const SUBAGENT_SYSTEM =
  "You are a sub-agent inside Gearbox, handling ONE delegated task. You do NOT see the parent conversation — everything you need is in the task description. Use your tools to read the repo, make the requested changes, and verify them. Stay tightly focused on the task; don't do unrelated work. When finished, reply with a short report: which files you changed and anything the orchestrator needs to know.";

let counter = 0;

/** Build the `delegate` tool, given a runner that executes a sub-agent loop. */
export function makeDelegateTool(opts: { onEvent: OnEvent; signal?: AbortSignal; run: SubAgentRunner }) {
  const { onEvent, signal, run } = opts;
  return tool({
    description:
      "Hand a self-contained sub-task to a fresh sub-agent that runs on the model best suited and cheapest for it (auto-routed across your providers/accounts), with full file tools in this same repo. Use it to offload bounded chunks — a focused refactor, bulk edits, reading/research, code generation — so you stay the orchestrator while a cheaper/faster/specialist model does the legwork. The sub-agent does NOT see this conversation, so make `task` completely self-contained (goal, file paths, constraints, definition of done). It runs to completion and returns a report of what it changed. Do small things yourself; delegate when a task is sizable or another model would handle it better or cheaper.",
    inputSchema: z.object({
      task: z.string().describe("The complete, self-contained sub-task: what to do, which files, constraints, and how to know it's done."),
      kind: z.enum(["code", "search", "summarize", "classify", "plan", "chat"]).optional().describe("Optional task-kind hint to steer model routing (inferred if omitted)."),
    }),
    execute: async ({ task, kind }) => {
      const k = kind ?? classify(task);
      let choice;
      try {
        choice = new RoutingSelector().select({ prompt: task, kind: k, requires: ["tools"] });
      } catch (e: any) {
        return `delegation failed: no model available for this sub-task (${e?.message ?? e}). Do it yourself.`;
      }
      // The sub-agent runs inside Gearbox's own loop with our tools, so it needs an
      // in-loop model; a flat-rate subscription seat (vendor CLI) can't host it.
      if (choice.backend?.kind === "cli") {
        return `delegation skipped: routing picked the ${choice.model.label} subscription, which can't host a sub-agent. Handle this task yourself, or add an API key so a routable model is available.`;
      }
      const acct = choice.backend?.kind === "in-loop" ? choice.backend.account : undefined;
      const creds = acct ? await resolveCreds(acct) : undefined;
      const id = `delegate-${++counter}`;
      onEvent({ type: "tool-start", id, name: "delegate", arg: `→ ${choice.model.label} · ${task.slice(0, 72)}` });
      // Forward only the sub-agent's tool activity (its file ops are worth seeing);
      // its prose is the report we return to the orchestrator, not the user's reply.
      const childOnEvent: OnEvent = (e) => { if (e.type === "tool-start" || e.type === "tool-end") onEvent(e); };
      let r: Awaited<ReturnType<SubAgentRunner>>;
      try {
        r = await run({ model: choice.model, creds, system: SUBAGENT_SYSTEM, prompt: task, onEvent: childOnEvent, signal });
      } catch (e: any) {
        onEvent({ type: "tool-end", id, ok: false, summary: `${choice.model.label} · failed` });
        return `sub-agent (${choice.model.label}) crashed: ${e?.message ?? e}`;
      }
      const costUSD = estimateCost([{ model: choice.model.id, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens }]);
      if (acct) recordUsage({ accountId: acct.id, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, costUSD, estimated: true });
      onEvent({ type: "tool-end", id, ok: !r.failure, summary: `${choice.model.label}${costUSD >= 0.005 ? ` · $${costUSD.toFixed(2)}` : ""}` });
      if (r.failure) return `sub-agent (${choice.model.label}) failed: ${r.failure.message}`;
      return r.text || "(sub-agent finished but returned no report)";
    },
  });
}
