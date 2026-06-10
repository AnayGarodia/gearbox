// ── THE ROUTING SEAM ──────────────────────────────────────────────────────
// This module defines the ModelSelector interface and the types that flow
// through it. Every component that invokes a model (agent loop, sub-task
// dispatcher, compaction, etc.) calls selector.select(task) and receives a
// ModelChoice. The concrete implementation can be swapped without touching
// any caller: FixedSelector always returns the configured default, while
// RoutingSelector (src/model/router.ts) scores all (model, account) pairs and
// picks the cheapest that clears the task's quality bar.
//
// Rule: never bypass this seam to call a provider directly. All routing logic
// belongs in the selector, so the agent loop stays provider-agnostic.
import { pickDefaultModel } from "../config.ts";
import type { ModelSpec } from "../providers.ts";
import type { ModelRequirement } from "./capabilities.ts";
import type { Account } from "../accounts/types.ts";

// How a chosen model is actually run. The router returns this so the runner can
// dispatch to the right backend WITHOUT the agent loop ever knowing which it is:
// `in-loop` = our own agent loop via the AI SDK (creds from `account`, or the
// env default when absent); `cli` = a subscription seat run through the vendor
// binary. Optional on ModelChoice so every existing caller is unchanged (absent
// means in-loop, today's path).
export type Backend =
  | { kind: "in-loop"; account?: Account }
  | { kind: "cli"; account: Account; binary: string; profile?: string };

// The inputs the router uses to decide which model to run. All fields are
// optional: FixedSelector ignores them, and RoutingSelector reads them to
// classify the task, set the quality bar, and size the context estimate.
// Callers only need to fill the fields they have; adding new fields here does
// not break existing callers.
export interface Task {
  prompt: string;
  // Classified task kind. When omitted the router classifies the prompt itself
  // (keyword heuristic, then LLM classifier). Callers that already know the
  // kind (e.g. "summarize the diff") can supply it directly to skip that step.
  kind?: "code" | "search" | "summarize" | "classify" | "plan" | "chat";
  estTokens?: number; // estimated working-set size for this turn
  touchedFiles?: string[]; // files in play, for locality-aware routing
  requires?: ModelRequirement[]; // runtime capabilities needed by this turn
  // Confidence-gated escalation: how many times the cheap pick already MISSED on
  // this work (a verification failure or failed auto-fix attempt). Each increment
  // raises the quality bar so the router climbs to a stronger model rather than
  // re-running the same too-weak one. 0 (the default) is the normal path;
  // FixedSelector ignores this field entirely.
  escalate?: number;
  // Latency class: true when the user is WAITING on this turn (a foreground
  // request), so the router pulls faster models forward among bar-clearing
  // candidates (done > fast > cheap when waiting). Omit for background work
  // (delegated sub-tasks, compaction) where latency is free and cheapest wins.
  interactive?: boolean;
}

export interface ModelChoice {
  model: ModelSpec;
  reason: string; // shown in the UI; becomes the routing scorecard later
  backend?: Backend; // how to run it (absent means in-loop). Set by RoutingSelector.
}

// One row in the "/why" scorecard: the full per-candidate breakdown that lets
// the user see exactly why each model was or was not chosen. The router populates
// this from scored candidates; the UI renders it in the tab panel.
export interface ScorecardEntry {
  /** Measured per-repo prior, when ≥4 verified outcomes exist ("measured here: 7/9 ✓ (−0.04)"). */
  priorNote?: string;
  label: string;
  backend: "api" | "seat";
  quality: number;
  qualitySrc: string; // "measured" | "researched" | "seeded"
  estCostPerMtok: number;
  balanceText?: string; // "$12.50" or "$12 est" or undefined when not applicable
  headroomText?: string; // subscription "84% left" or "throttling" for near-limit metered keys
  score: number;
  chosen: boolean;
  verdict: string;
}

// The full ranked "why" behind a routing decision. kind and bar give the
// routing context; entries list every candidate with its score and verdict,
// sorted best-first. Exposed on the seam so any selector (not just the router)
// can implement explain().
export interface Scorecard {
  kind: NonNullable<Task["kind"]>;
  /** How the kind was determined ("llm" | "keyword" | "cache" | "fallback") —
   *  set by the caller (App) from the last turn's classification so a fallback
   *  default is never mistaken for a real classifier verdict. */
  kindSource?: string;
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
    // pickDefaultModel silently falls back to the first available model when
    // the pinned id can't be served (key removed, model un-discovered). Saying
    // "pinned" about a model the user did NOT pin is a lie — name the swap.
    if (this.preferredId && model.id !== this.preferredId) {
      return { model, reason: `pinned ${this.preferredId} unavailable → ${model.id} · /model auto to route per task` };
    }
    return { model, reason: "pinned · /model auto to route per task" };
  }
}
