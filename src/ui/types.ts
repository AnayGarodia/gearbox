import type { UsageView } from "../accounts/usage.ts";

// One transcript item as the UI sees it. Built from the AgentEvent stream.
export type Item =
  | { kind: "user"; id: number; text: string }
  | { kind: "assistant"; id: number; text: string; done: boolean }
  | { kind: "tool"; id: number; callId: string; name: string; arg: string; status: "running" | "ok" | "err"; summary: string; diff?: { sign: "+" | "-"; text: string }[]; stream?: string; streamCount?: number }
  | { kind: "notice"; id: number; text: string }
  | { kind: "usage"; id: number; view: UsageView } // structured /usage card (colored bars)
  | { kind: "error"; id: number; text: string };
