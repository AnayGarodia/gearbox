// ── THE ROUTING SEAM ──────────────────────────────────────────────────────
// Everything that runs a model goes through a ModelSelector. v0.1 ships a
// FixedSelector (one model). The router will implement this same interface and
// drop in here with ZERO changes upstream — the agent loop never knows which
// selector it has. Do not bypass this to call a provider directly.
import { pickDefaultModel } from "../config.ts";
import type { ModelSpec } from "../providers.ts";
import type { ModelRequirement } from "./capabilities.ts";
import type { Account } from "../accounts/types.ts";

// How a chosen model is actually run. The router returns this so the runner can
// dispatch to the right backend WITHOUT the agent loop ever knowing which it is:
// `in-loop` = our own agent loop via the AI SDK (creds from `account`, or the
// env default when absent); `cli` = a subscription seat run through the vendor
// binary. Optional on ModelChoice so every existing caller is unchanged (absent
// ⇒ in-loop, today's path).
export type Backend =
  | { kind: "in-loop"; account?: Account }
  | { kind: "cli"; account: Account; binary: string; profile?: string };

export interface Task {
  prompt: string;
  // Future routing inputs live here (classified type, touched files, history
  // size, latency class). Adding them must not change the interface shape for
  // callers — they always just hand over a Task. All optional; FixedSelector
  // ignores them, so the seam stays intact until the router reads them.
  kind?: "code" | "search" | "summarize" | "classify" | "plan" | "chat";
  estTokens?: number; // estimated working-set size for this turn
  touchedFiles?: string[]; // files in play, for locality-aware routing
  requires?: ModelRequirement[]; // runtime capabilities needed by this turn
}

export interface ModelChoice {
  model: ModelSpec;
  reason: string; // shown in the UI; becomes the routing scorecard later
  backend?: Backend; // how to run it (absent ⇒ in-loop). Set by RoutingSelector.
}

export interface ModelSelector {
  select(task: Task): ModelChoice;
}

/** v0.1: always the configured/available default. The one place model choice happens. */
export class FixedSelector implements ModelSelector {
  constructor(private preferredId?: string) {}

  select(_task: Task): ModelChoice {
    const model = pickDefaultModel(this.preferredId);
    if (!model) {
      throw new Error(
        "No model available. Set a key: ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY / DEEPSEEK_API_KEY",
      );
    }
    return { model, reason: "fixed default · routing not enabled yet" };
  }
}
