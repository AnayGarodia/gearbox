// Shared shell runner: used by the run_shell tool AND the `!` prefix.
// Intentionally runs through a shell — that is the point (tests, git, pipes).
// Safety belongs in a confirm/permission gate (planned), not in avoiding the shell.
import { execSync } from "node:child_process";
import { ShellSession } from "./shell-session.ts";

const CAP = 60_000;
const clip = (s: string) => (s.length > CAP ? s.slice(0, CAP) + `\n… [clipped ${s.length - CAP} chars]` : s);

export interface ShellChunk {
  stream: "stdout" | "stderr";
  text: string;
}

export interface ShellResult {
  ok: boolean;
  output: string;
  exitCode: number | null;
  durationMs: number;
  timedOut?: boolean;
}

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

// Persistent shells so `cd`, `export`, and `source` carry across commands (the
// `!` prefix, the run_shell tool, and verification all share one). Sessions are
// keyed by working dir: the main agent shares the process-cwd session, while a
// parallel sub-agent running in its own git worktree (opts.cwd) gets an isolated
// one, so concurrent fan-out shells don't share state. Each lazily (re)starts.
const sessions = new Map<string, ShellSession>();
function shellSession(cwd?: string): ShellSession {
  const root = cwd ?? process.cwd();
  let session = sessions.get(root);
  if (!session) {
    session = new ShellSession(root);
    sessions.set(root, session);
  }
  return session;
}

/** Streaming shell runner for live tool/UI output, backed by a persistent session. */
export async function runShellStream(
  command: string,
  opts: { signal?: AbortSignal; timeoutMs?: number; onChunk?: (chunk: ShellChunk) => void; cwd?: string } = {},
): Promise<ShellResult> {
  const started = Date.now();
  const root = opts.cwd ?? process.cwd();
  const r = await shellSession(root).run(command, {
    timeoutMs: opts.timeoutMs ?? 60_000,
    signal: opts.signal,
    onChunk: opts.onChunk,
  });
  // A dead session (e.g. after a timeout kill) is dropped so the next call starts fresh.
  if (r.timedOut) sessions.delete(root);
  return {
    ok: r.ok,
    output: clip(r.output || "(no output)"),
    exitCode: r.exitCode,
    durationMs: Date.now() - started,
    timedOut: r.timedOut,
  };
}
