// The normalized event stream the UI consumes. The UI never sees the AI SDK's
// raw types — only these. This decouples the interface from the provider layer
// AND from routing (the mock runner and the real runner both emit AgentEvents).

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export type DiffLine = { sign: "+" | "-"; text: string };

export type AgentEvent =
  | { type: "text"; text: string } // a chunk of assistant prose
  | { type: "tool-start"; id: string; name: string; arg: string } // tool call began
  | { type: "tool-end"; id: string; ok: boolean; summary: string; diff?: DiffLine[] } // tool call finished
  | { type: "done"; usage: Usage } // turn complete
  | { type: "error"; message: string };

export type OnEvent = (e: AgentEvent) => void;
