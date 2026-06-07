// The normalized event stream the UI consumes. The UI never sees the AI SDK's
// raw types — only these. This decouples the interface from the provider layer
// AND from routing (the mock runner and the real runner both emit AgentEvents).

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number; // prompt-cache READ tokens (the cache hit; bills ≈10% of input)
  cacheCreationInputTokens?: number; // prompt-cache WRITE tokens (Anthropic; bills ≈125% for the 5m TTL)
}

export type DiffLine = { sign: "+" | "-"; text: string };

export type AgentEvent =
  | { type: "model-pick"; model: string; provider: string; reason: string }
  | { type: "phase"; label: string; detail?: string; state?: "running" | "ok" | "err" }
  | { type: "text"; text: string } // a chunk of assistant prose
  | { type: "tool-start"; id: string; name: string; arg: string } // tool call began (fires as input starts streaming)
  | { type: "tool-stream"; id: string; arg?: string; delta?: string } // tool input streaming: `arg` updates the head, `delta` appends streamed content (e.g. a file being written)
  | { type: "tool-output"; id?: string; name?: string; arg?: string; stream: "stdout" | "stderr"; text: string }
  | { type: "tool-end"; id: string; ok: boolean; summary: string; diff?: DiffLine[] } // tool call finished
  | { type: "file-change"; path: string; before: string; existed: boolean } // a write/edit mutated a file (for /undo + /diff)
  | { type: "verification"; command: string; ok: boolean; summary: string; intent?: string; durationMs?: number; output?: string }
  | { type: "preference-suggestion"; id: string; text: string; acceptCommand: string }
  | { type: "done"; usage: Usage } // turn complete
  | { type: "error"; message: string };

export type OnEvent = (e: AgentEvent) => void;
