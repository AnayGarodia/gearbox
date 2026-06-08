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
  // Confidence-gated escalation: how many times the cheap pick already MISSED on
  // this work (a verification failure / failed auto-fix attempt). Each step raises
  // the quality bar so the router climbs to a stronger model rather than re-running
  // the same too-weak one — the reactive half of "cheapest model that clears the
  // bar". 0 (the default) is today's behavior; FixedSelector ignores it.
  escalate?: number;
  // Latency class: true when the user is WAITING on this turn (a foreground request),
  // so the router prefers a faster model among bar-clearing candidates (done > FAST >
  // cheap when waiting). Omitted/false for background work (delegated sub-tasks,
  // compaction) where latency is free and cheapest should win.
  interactive?: boolean;
}

export interface ModelChoice {
  model: ModelSpec;
  reason: string; // shown in the UI; becomes the routing scorecard later
  backend?: Backend; // how to run it (absent ⇒ in-loop). Set by RoutingSelector.
}

// The full ranked "why" behind a routing decision — the data the ⌃tab / `/why`
// scorecard renders. Lives on the seam so any selector can expose it.
export interface ScorecardEntry {
  label: string;
  backend: "api" | "seat";
  quality: number;
  qualitySrc: string; // "measured" | "researched" | "seeded"
  estCostPerMtok: number;
  balanceText?: string; // "$12.50" / "$12 est" / undefined
  headroomText?: string; // subscription "84% left" / "throttling"
  score: number;
  chosen: boolean;
  verdict: string;
}
export interface Scorecard {
  kind: NonNullable<Task["kind"]>;
  bar: number;
  prompt: string;
  entries: ScorecardEntry[];
  note?: string;
}

export interface ModelSelector {
  select(task: Task): ModelChoice;
  explain?(task: Task): Scorecard; // optional: routing selectors expose the full scorecard
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
    return { model, reason: "pinned · /model auto to route per task" };
  }
}
