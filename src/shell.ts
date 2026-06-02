// Shared shell runner: used by the run_shell tool AND the `!` prefix.
// Intentionally runs through a shell — that is the point (tests, git, pipes).
// Safety belongs in a confirm/permission gate (planned), not in avoiding the shell.
import { execSync } from "node:child_process";

const CAP = 60_000;
const clip = (s: string) => (s.length > CAP ? s.slice(0, CAP) + `\n… [clipped ${s.length - CAP} chars]` : s);

export function runShell(command: string): { ok: boolean; output: string } {
  try {
    const out = execSync(command, {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output: clip(out || "(no output)") };
  } catch (e: any) {
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
    return { ok: false, output: clip(`exit ${e.status ?? "?"}\n${out || e.message}`) };
  }
}
