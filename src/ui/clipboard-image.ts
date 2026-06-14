// Pull an image off the system clipboard and write it to a temp PNG, so cmd-V of
// a screenshot attaches it the same way drag-and-drop of a file path does.
//
// Why this is needed: a terminal can't paste binary into a TUI. When the
// clipboard holds an image but no text, the paste arrives as an EMPTY bracketed
// paste (\x1b[200~\x1b[201~ with nothing between). On that signal we shell out to
// the OS clipboard and grab the bytes directly. Best-effort and synchronous so it
// slots into the key handler; returns null when there's no image (the empty paste
// then just inserts nothing, as before).
import { spawnSync } from "node:child_process";
import { existsSync, statSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAttachmentDir } from "../tools.ts";

function tempPng(): string {
  const dir = mkdtempSync(join(tmpdir(), "gearbox-paste-"));
  // Whitelist this dir for READ-ONLY tools (it's outside the workspace root);
  // scoped to this process so other sessions' pastes stay unreadable.
  registerAttachmentDir(dir);
  return join(dir, "clipboard.png");
}

// macOS: AppleScript reads the clipboard as PNG and writes it to `out`. Returns
// "ok" only when the clipboard actually held an image.
function grabMac(out: string): boolean {
  const script = `
set outFile to (POSIX file ${JSON.stringify(out)})
try
  set theData to (the clipboard as «class PNGf»)
on error
  return "no-image"
end try
set fh to open for access outFile with write permission
set eof fh to 0
write theData to fh
close access fh
return "ok"`;
  const r = spawnSync("osascript", ["-e", script], { encoding: "utf8", timeout: 4000 });
  return r.status === 0 && (r.stdout ?? "").trim() === "ok";
}

// Linux: try Wayland (wl-paste) then X11 (xclip). Either writes PNG bytes to out.
function grabLinux(out: string): boolean {
  for (const [cmd, args] of [
    ["wl-paste", ["--type", "image/png"]],
    ["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]],
  ] as const) {
    const r = spawnSync(cmd, args, { timeout: 4000, maxBuffer: 16 * 1024 * 1024 });
    if (r.status === 0 && r.stdout && r.stdout.length > 0) {
      try {
        require("node:fs").writeFileSync(out, r.stdout);
        return true;
      } catch {
        return false;
      }
    }
  }
  return false;
}

/** Returns the path to a freshly-written PNG if the clipboard holds an image, else null. */
export function clipboardImageToFile(): string | null {
  let out: string;
  try {
    out = tempPng();
  } catch {
    return null;
  }
  let ok = false;
  try {
    ok = process.platform === "darwin" ? grabMac(out) : process.platform === "linux" ? grabLinux(out) : false;
  } catch {
    ok = false;
  }
  if (!ok || !existsSync(out)) return null;
  try {
    if (statSync(out).size === 0) return null;
  } catch {
    return null;
  }
  return out;
}
