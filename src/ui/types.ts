import type { UsageView } from "../accounts/usage.ts";
import type { HealthState } from "../accounts/types.ts";
import type { Scorecard } from "../model/selector.ts";

// Structured /context card: one bar per working-set section + a window-fill bar.
export interface ContextRow {
  label: string; // padded to labelPad
  display: string; // formatted token count, e.g. "2.5k"
  frac: number; // 0..1 of the largest section (the bar)
  pct?: number; // 0..100 of the CONTEXT WINDOW (where the budget actually goes)
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
  detail?: string;
  duplicateOf?: string;
  health?: HealthState;
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
  | { kind: "user"; id: number; text: string; turnNo?: number; at?: number } // turnNo: real turns get a numbered heading; command echoes stay small. at: wall-clock for the optional timestamp.
  | { kind: "assistant"; id: number; text: string; done: boolean }
  | {
      kind: "tool";
      id: number;
      callId: string;
      name: string;
      arg: string;
      status: "running" | "ok" | "err";
      summary: string;
      diff?: { sign: "+" | "-"; text: string; gap?: boolean }[];
      stream?: string;
      streamCount?: number;
      activity?: string; // a single REPLACING live status line (e.g. a delegate's "reading X · 12 tools")
      outputTail?: string;
      outputLines?: number;
      preview?: string;
      previewLines?: number;
      previewLang?: string;
      startedAt?: number;
      endedAt?: number;
      durationMs?: number;
      exitCode?: number | null;
      // Set ONLY by collapseTurn at turn-settle: a finished delegate_parallel group
      // folds its child tool items in here and renders as one summary row, expanded
      // (the children) under ⌃O. Live items never carry these.
      collapsed?: boolean;
      children?: Item[];
      // LSP diagnostics for the file this write/edit touched, attached by the
      // verify fast tier (App.tsx runLspTier) — rendered under the diff as
      // `◆ line:col message` rows in err/warn ink.
      diagnostics?: { line: number; col?: number; severity: "error" | "warning"; message: string }[];
    }
  | { kind: "phase"; id: number; label: string; detail?: string; state: "running" | "ok" | "err" }
  // Post-turn routing provenance line: `routed → provider · model · cost`.
  // `costText` is the formatted per-turn cost; `surprising`/`reason` are set only
  // for the three brief-defined surprising cases (escalation / fallback / cap hit),
  // which brighten the line to amber. Built by src/ui/routing-line.ts.
  | { kind: "model"; id: number; model: string; provider: string; costText?: string; surprising?: boolean; reason?: string }
  | {
      kind: "verification";
      id: number;
      command: string; // the literal command (shown only behind ⌃O)
      ok: boolean; // FINAL state after any retries
      summary: string;
      intent?: string; // "typecheck" / "test" / "build" / "lint" — the named action
      attempts?: number; // how many times this check ran (1 = no retry)
      durationMs?: number; // total wall time across attempts, when known
      output?: string; // last attempt's output, revealed by ⌃O
    }
  | { kind: "preference"; id: number; text: string; acceptCommand: string }
  | { kind: "plan"; id: number; steps: { text: string; status: "pending" | "in_progress" | "done" }[] } // live checklist (update_plan); rendered in place
  | { kind: "summary"; id: number; changed: string[]; checks: string[]; failures: string[]; next?: string; tier?: "tests" | "types" | "none" }
  | { kind: "notice"; id: number; text: string }
  | { kind: "accounts"; id: number; view: AccountView }
  | { kind: "usage"; id: number; view: UsageView } // structured /usage card (colored bars)
  | { kind: "context"; id: number; view: ContextView } // structured /context card (colored bars)
  | { kind: "scorecard"; id: number; card: Scorecard; savingsNote?: string } // structured /why routing scorecard (savingsNote: session saved-vs-premium summary)
  | { kind: "error"; id: number; text: string };
