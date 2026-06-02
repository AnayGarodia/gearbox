// Pure key → action reducer for the composer. Kept pure so it's unit-tested
// without a terminal. The Composer's useInput just dispatches what this returns.
import type { Key } from "ink";

export interface Edit {
  value: string;
  cursor: number;
}

export type KeyAction =
  | { type: "edit"; state: Edit }
  | { type: "submit" }
  | { type: "history"; dir: "up" | "down" }
  | { type: "interrupt" }
  | { type: "none" };

export function applyKey(s: Edit, input: string, key: Key): KeyAction {
  if (key.return) return { type: "submit" };
  if (key.escape) return { type: "interrupt" };
  if (key.upArrow) return { type: "history", dir: "up" };
  if (key.downArrow) return { type: "history", dir: "down" };
  if (key.leftArrow) return { type: "edit", state: { value: s.value, cursor: Math.max(0, s.cursor - 1) } };
  if (key.rightArrow) return { type: "edit", state: { value: s.value, cursor: Math.min(s.value.length, s.cursor + 1) } };
  if (key.ctrl && input === "a") return { type: "edit", state: { value: s.value, cursor: 0 } }; // home
  if (key.ctrl && input === "e") return { type: "edit", state: { value: s.value, cursor: s.value.length } }; // end
  if (key.backspace || key.delete) {
    if (s.cursor <= 0) return { type: "none" };
    return { type: "edit", state: { value: s.value.slice(0, s.cursor - 1) + s.value.slice(s.cursor), cursor: s.cursor - 1 } };
  }
  if (input && !key.ctrl && !key.meta && !key.tab) {
    return { type: "edit", state: { value: s.value.slice(0, s.cursor) + input + s.value.slice(s.cursor), cursor: s.cursor + input.length } };
  }
  return { type: "none" };
}
