/**
 * Normalized event stream consumed by the UI layer.
 *
 * Every module that can produce agent output (the real runner in run.ts, the
 * mock runner in mock.ts, and the failover wrapper in failover.ts) emits only
 * these types. The UI never sees raw AI SDK types, provider-specific objects,
 * or tool-execution internals. This boundary lets the rendering layer stay
 * stable across SDK upgrades, provider swaps, and routing changes.
 *
 * Event flow during a typical turn:
 *   phase("contacting model")
 *   text* (assistant prose, streamed)
 *   tool-start, tool-stream*, tool-end (zero or more tool calls)
 *   done (usage totals)
 *
 * Errors surface as an "error" event (optionally preceded by a "phase" with
 * state "err"). The "done" event is emitted even on error so consumers can
 * always finalize usage state.
 */

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /**
   * Prompt-cache READ tokens (the cache hit). Bills at roughly 10% of normal
   * input cost on Anthropic; other providers that support auto-caching report
   * the same field but may bill differently.
   */
  cachedInputTokens?: number;
  /**
   * Prompt-cache WRITE tokens (Anthropic only). Bills at roughly 125% of
   * normal input cost but amortizes across the 5-minute TTL window. Reported
   * per step (not on the final finish event) and accumulated by the runner.
   */
  cacheCreationInputTokens?: number;
}

export type DiffLine = { sign: "+" | "-"; text: string };

/**
 * Discriminated union of every event the agent pipeline can emit.
 *
 * Consumers should switch on `type` and ignore unknown variants for forward
 * compatibility. Fields shared across variants (e.g. `id` on tool events) use
 * the same stable call ID so the UI can correlate start/stream/end triples.
 */
export type AgentEvent =
  /**
   * The router chose a model. Emitted before the turn starts so the status
   * bar can show the active model without waiting for the first token.
   */
  | { type: "model-pick"; model: string; provider: string; reason: string }

  /**
   * Lifecycle label for a phase of the turn (contacting model, editing files,
   * etc.). `state` drives the spinner/icon in the UI. An "err" state marks the
   * turn as failed without necessarily ending it.
   */
  | { type: "phase"; label: string; detail?: string; state?: "running" | "ok" | "err" }

  /** A chunk of assistant prose. Consumers append these to build the full reply. */
  | { type: "text"; text: string }

  /**
   * A tool call began. Fires as soon as the tool name is known (before the
   * full input arrives) so the UI can open the item immediately. `arg` holds
   * the best available one-line summary at that moment.
   */
  | { type: "tool-start"; id: string; name: string; arg: string }

  /**
   * Incremental update to an in-progress tool call. The three payload fields
   * are mutually exclusive by convention:
   *   `arg`      updates the head label (path or command, once decoded).
   *   `delta`    appends streamed file content (write_file / edit_file body).
   *   `activity` replaces a single live status line (delegate progress text).
   */
  | { type: "tool-stream"; id: string; arg?: string; delta?: string; activity?: string }

  /** A line written to stdout or stderr by a shell tool during execution. */
  | { type: "tool-output"; id?: string; name?: string; arg?: string; stream: "stdout" | "stderr"; text: string }

  /**
   * A tool call finished. `ok` distinguishes success from a tool-level error
   * (distinct from a model/network error). `diff` carries line-level change
   * data for file writes so the UI can render a compact diff inline.
   */
  | { type: "tool-end"; id: string; ok: boolean; summary: string; diff?: DiffLine[] }

  /**
   * A file was mutated by a write or edit tool. Carries the pre-edit content
   * so the turn can be undone (/undo) and the delta can be shown (/diff).
   * `existed` distinguishes new files from overwrites.
   */
  | { type: "file-change"; path: string; before: string; existed: boolean }

  /** A post-edit verification command ran (e.g. tests or a type check). */
  | { type: "verification"; command: string; ok: boolean; summary: string; intent?: string; durationMs?: number; output?: string }

  /** The model suggested storing a user preference. `acceptCommand` is the slash command to accept it. */
  | { type: "preference-suggestion"; id: string; text: string; acceptCommand: string }

  /** A live plan/checklist the model maintains for a multi-step task (update_plan
   *  tool). Each call replaces the whole list; the UI renders it in place so the
   *  user sees the plan + current step + progress, not a wall of tool logs. */
  | { type: "plan"; steps: { text: string; status: "pending" | "in_progress" | "done" }[] }

  /**
   * The turn completed. Always emitted last, even after an error, so
   * consumers can finalize usage counters and close any open UI items.
   */
  | { type: "done"; usage: Usage }

  /** A terminal error occurred. The turn will not produce further output. */
  | { type: "error"; message: string };

/** Callback type accepted by every function that drives the agent pipeline. */
export type OnEvent = (e: AgentEvent) => void;
