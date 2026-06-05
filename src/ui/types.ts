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

export interface AccountRow {
  name: string;
  type: "subscription" | "API key";
  status: string;
  active: boolean;
  alias: string;
  number: number;
  detail?: string;
  duplicateOf?: string;
}
export interface AccountView {
  current: string;
  rows: AccountRow[];
  importable: { provider: string; label: string; envVar: string }[];
  labelPad: number;
  statusPad: number;
}

// One transcript item as the UI sees it. Built from the AgentEvent stream.
export type Item =
  | { kind: "user"; id: number; text: string }
  | { kind: "assistant"; id: number; text: string; done: boolean }
  | {
      kind: "tool";
      id: number;
      callId: string;
      name: string;
      arg: string;
      status: "running" | "ok" | "err";
      summary: string;
      diff?: { sign: "+" | "-"; text: string }[];
      stream?: string;
      streamCount?: number;
      outputTail?: string;
      outputLines?: number;
      preview?: string;
      previewLines?: number;
      previewLang?: string;
      startedAt?: number;
      endedAt?: number;
      durationMs?: number;
      exitCode?: number | null;
    }
  | { kind: "phase"; id: number; label: string; detail?: string; state: "running" | "ok" | "err" }
  | { kind: "model"; id: number; model: string; provider: string; reason: string }
  | { kind: "verification"; id: number; command: string; ok: boolean; summary: string }
  | { kind: "preference"; id: number; text: string; acceptCommand: string }
  | { kind: "summary"; id: number; changed: string[]; checks: string[]; failures: string[]; next?: string }
  | { kind: "notice"; id: number; text: string }
  | { kind: "accounts"; id: number; view: AccountView }
  | { kind: "usage"; id: number; view: UsageView } // structured /usage card (colored bars)
  | { kind: "context"; id: number; view: ContextView } // structured /context card (colored bars)
  | { kind: "error"; id: number; text: string };
