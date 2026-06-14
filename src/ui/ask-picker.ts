// Pure reducer for the ask_user picker: steps through option-based questions one
// at a time, single- or multi-select, accumulating answers. The component and
// App keyboard layer hold no logic beyond mapping bytes → AskPickerKey.
import type { AskQuestion, AskAnswer } from "../ask.ts";

export interface AskPickerState {
  qIndex: number;
  cursor: number;
  selected: Set<number>; // toggled options for the CURRENT question (multi-select)
  answers: AskAnswer[]; // accumulated, one per answered question
  done: boolean;
  cancelled: boolean;
}

export type AskPickerKey = "up" | "down" | "toggle" | "confirm" | "cancel";

export function initAskPicker(): AskPickerState {
  return { qIndex: 0, cursor: 0, selected: new Set(), answers: [], done: false, cancelled: false };
}

function optionCount(q: AskQuestion): number {
  return q.options?.length ?? 0;
}

export function askPickerReduce(s: AskPickerState, key: AskPickerKey, questions: AskQuestion[]): AskPickerState {
  if (s.done) return s;
  const q = questions[s.qIndex];
  if (!q) return { ...s, done: true };
  const n = optionCount(q);
  switch (key) {
    case "up":
      return n ? { ...s, cursor: (s.cursor - 1 + n) % n } : s;
    case "down":
      return n ? { ...s, cursor: (s.cursor + 1) % n } : s;
    case "toggle": {
      if (!q.multiSelect || !n) return s;
      const selected = new Set(s.selected);
      if (selected.has(s.cursor)) selected.delete(s.cursor);
      else selected.add(s.cursor);
      return { ...s, selected };
    }
    case "confirm": {
      if (!n) return s; // free-text questions aren't pickable here; ignore
      // multi: the toggled set (default to the cursor if nothing toggled);
      // single: just the cursor.
      const picks = q.multiSelect ? (s.selected.size ? [...s.selected].sort((a, b) => a - b) : [s.cursor]) : [s.cursor];
      const labels = picks.map((i) => q.options![i]!.label);
      const answers = [...s.answers, { question: q.question, answers: labels }];
      const last = s.qIndex >= questions.length - 1;
      if (last) return { ...s, answers, done: true };
      return { ...s, qIndex: s.qIndex + 1, cursor: 0, selected: new Set(), answers };
    }
    case "cancel":
      return { ...s, done: true, cancelled: true };
    default:
      return s;
  }
}

export interface AskRenderColors { R: string; C: string; G: string; D: string; B: string; }

// Render the CURRENT question + its options (cursor + checkbox/radio).
export function renderAskQuestion(questions: AskQuestion[], s: AskPickerState, c?: Partial<AskRenderColors>): string[] {
  const R = c?.R ?? "", C = c?.C ?? "", G = c?.G ?? "", D = c?.D ?? "", B = c?.B ?? "";
  const q = questions[s.qIndex];
  if (!q) return [];
  const out: string[] = [];
  const counter = questions.length > 1 ? `${D}(${s.qIndex + 1}/${questions.length})${R} ` : "";
  out.push(`${B}${counter}${q.question}${R}`);
  (q.options ?? []).forEach((opt, i) => {
    const here = i === s.cursor;
    const mark = q.multiSelect ? (s.selected.has(i) ? `${G}[x]${R}` : "[ ]") : here ? `${C}◉${R}` : "○";
    const pointer = here ? `${C}❯${R}` : " ";
    const label = here ? `${B}${opt.label}${R}` : opt.label;
    out.push(`  ${pointer} ${mark} ${label}${opt.description ? `  ${D}${opt.description}${R}` : ""}`);
  });
  const hint = q.multiSelect ? "↑↓ move · space toggle · ⏎ next · esc skip" : "↑↓ move · ⏎ select · esc skip";
  out.push(`${D}    ${hint}${R}`);
  return out;
}
