import type { UsageView } from "../accounts/usage.ts";

// Structured /context card: one bar per working-set section + a window-fill bar.
export interface ContextRow {
  label: string; // padded to labelPad
  display: string; // formatted token count, e.g. "2.5k"
  frac: number; // 0..1 of the largest section (the bar)
}
export interface ContextView {
  rows: ContextRow[];
  total: string; // formatted total tokens
  windowPct?: number; // 0..100 of the context window
  windowLabel?: string; // formatted window size, e.g. "1000k"
  cwd: string;
  labelPad: number;
  valuePad: number;
}

// One transcript item as the UI sees it. Built from the AgentEvent stream.
export type Item =
  | { kind: "user"; id: number; text: string }
  | { kind: "assistant"; id: number; text: string; done: boolean }
  | { kind: "tool"; id: number; callId: string; name: string; arg: string; status: "running" | "ok" | "err"; summary: string; diff?: { sign: "+" | "-"; text: string }[]; stream?: string; streamCount?: number }
  | { kind: "notice"; id: number; text: string }
  | { kind: "usage"; id: number; view: UsageView } // structured /usage card (colored bars)
  | { kind: "context"; id: number; view: ContextView } // structured /context card (colored bars)
  | { kind: "error"; id: number; text: string };
