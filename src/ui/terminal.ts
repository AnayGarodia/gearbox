// Small terminal-integration helpers: window/tab title, bell, and an OS
// notification. All best-effort and no-ops when there's no TTY.

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
    Bun.spawn(["osascript", "-e", `display notification "${esc(body)}" with title "${esc(title)}"`], {
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    /* ignore */
  }
}
