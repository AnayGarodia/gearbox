// Copy to the system clipboard from inside the TUI. Primary path is OSC 52
// (`ESC ] 52 ; c ; <base64> BEL`), which the terminal itself honors — so it works
// over SSH and inside tmux, unlike shelling out to pbcopy/xclip. We also try the
// platform clipboard binary as a best-effort fallback for terminals that don't
// implement OSC 52. Both are fire-and-forget; copying never throws.
import { spawnProc } from "../proc.ts";

/** Build the raw OSC 52 sequence for `text` (exported for testing). */
export function osc52(text: string): string {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  return `\x1b]52;c;${b64}\x07`;
}

function platformClipboardCmd(): string[] | null {
  if (process.platform === "darwin") return ["pbcopy"];
  if (process.platform === "win32") return ["clip"];
  // Linux/BSD: prefer wayland, fall back to X. Either may be absent (that's fine).
  return null; // handled below by trying both
}

/** Copy `text` to the clipboard. Writes OSC 52 to the tty AND tries a native tool. */
export function copyToClipboard(text: string): void {
  try {
    if (process.stdout.isTTY) process.stdout.write(osc52(text));
  } catch {
    /* ignore */
  }
  // Best-effort native fallback (helps terminals without OSC 52, e.g. Terminal.app).
  try {
    const direct = platformClipboardCmd();
    const candidates = direct ? [direct] : [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "-ib"]];
    for (const [cmd, ...args] of candidates) {
      try {
        const p = spawnProc([cmd!, ...args], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
        p.stdin?.write(text);
        p.stdin?.end();
        break; // first one that spawns wins
      } catch {
        /* try next */
      }
    }
  } catch {
    /* ignore — OSC 52 already attempted */
  }
}
