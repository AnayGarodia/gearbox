// Small terminal-integration helpers: window/tab title, bell, and an OS
// notification. All best-effort and no-ops when there's no TTY.
import { spawnProc } from "../proc.ts";

/** Set the terminal window/tab title via OSC 2 (`ESC ] 2 ; <title> BEL`). */
export function setTitle(title: string): void {
  try {
    if (process.stdout.isTTY) process.stdout.write(`\x1b]2;${title}\x07`);
  } catch {
    /* ignore */
  }
}

/** Ring the terminal bell. */
export function bell(): void {
  try {
    if (process.stdout.isTTY) process.stdout.write("\x07");
  } catch {
    /* ignore */
  }
}

/** Fire a desktop notification (macOS only for now; silently no-ops elsewhere). */
export function notify(title: string, body: string): void {
  try {
    if (process.platform !== "darwin") return;
    const esc = (s: string) => s.replace(/["\\]/g, "\\$&");
    spawnProc(["osascript", "-e", `display notification "${esc(body)}" with title "${esc(title)}"`], {
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    /* ignore */
  }
}

// ── Mouse‑event wiring ────────────────────────────────────────────────────

import type { Edit, KeyAction, MouseClick } from "./input";
import { applyMouse } from "./input";

/**
 * Parse an SGR‑encoded mouse event (the kind Ink emits via `onMouse`) and
 * return the corresponding `KeyAction` for the composer.
 *
 * The raw event object is expected to have the shape:
 *   { button: number; x: number; y: number; shift: boolean; meta: boolean; ctrl: boolean }
 *
 * `button` values:
 *   0 – left press
 *   1 – middle press
 *   2 – right press
 *   3 – release (any button)
 *   4 – scroll up
 *   5 – scroll down
 *
 * We only act on left‑button presses (button === 0).  Double‑ and triple‑click
 * detection is handled by the caller (the component) because Ink doesn’t
 * provide a click‑count.  The component should track the last click time and
 * position and call this function with the appropriate `count`.
 */
export function mouseEventToAction(
  s: Edit,
  raw: { button: number; x: number; y: number; shift: boolean; meta: boolean; ctrl: boolean },
  count: number,
): KeyAction {
  // Only left‑button presses are relevant for text selection.
  if (raw.button !== 0) return { type: "none" };

  const click: MouseClick = {
    col: raw.x,
    line: raw.y,
    count,
    shift: raw.shift,
  };

  return applyMouse(s, click);
}
