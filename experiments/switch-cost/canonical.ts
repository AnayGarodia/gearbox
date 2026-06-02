// Canonical, model-agnostic conversation state.
// This is the source of truth. Provider message arrays are PROJECTIONS of this,
// rendered on demand (see renderers.ts). Nothing here is provider-specific.

export type JSONSchema = {
  type: "object";
  properties: Record<string, { type: string; description?: string }>;
  required?: string[];
};

export type ToolDef = {
  name: string;
  description: string;
  parameters: JSONSchema;
};

// One unit of conversation. Deliberately NOT shaped like any provider's wire format.
export type Turn =
  | { kind: "user_text"; text: string }
  | { kind: "assistant_text"; text: string }
  | { kind: "thinking"; text: string } // reasoning; some providers keep, some drop
  | { kind: "assistant_tool_call"; callId: string; name: string; args: Record<string, unknown> }
  | { kind: "tool_result"; callId: string; name: string; result: string };

// A durable fact in the ledger. Provenance + validity is what makes
// context-poisoning RECOVERABLE: flip `valid` to false and it vanishes from
// every future projection without rewriting history.
export type Fact = {
  id: string;
  text: string;
  provenance: string; // where it came from (tool result, user, inference)
  valid: boolean;
};

export type CanonicalState = {
  system: string;
  tools: ToolDef[];
  turns: Turn[];
  facts: Fact[];
  openTask: string; // the current task spec — survives compaction
};
