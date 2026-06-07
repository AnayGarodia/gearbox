// Shared shell runner: used by the run_shell tool AND the `!` prefix.
// Intentionally runs through a shell — that is the point (tests, git, pipes).
// Safety belongs in a confirm/permission gate (planned), not in avoiding the shell.
import { execSync } from "node:child_process";
import { spawnProc } from "./proc.ts";

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

/** Streaming shell runner for live tool/UI output. */
export async function runShellStream(
  command: string,
  opts: { signal?: AbortSignal; timeoutMs?: number; onChunk?: (chunk: ShellChunk) => void; cwd?: string } = {},
): Promise<ShellResult> {
  const started = Date.now();
  const chunks: string[] = [];
  const proc = spawnProc(["/bin/sh", "-lc", command], {
    cwd: opts.cwd ?? process.cwd(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const kill = () => {
    try {
      proc.kill();
    } catch {
      /* already exited */
    }
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    kill();
  }, opts.timeoutMs ?? 60_000);
  const onAbort = () => kill();
  opts.signal?.addEventListener("abort", onAbort);

  const read = async (stream: NodeJS.ReadableStream | null, name: "stdout" | "stderr") => {
    if (!stream) return;
    const dec = new TextDecoder();
    for await (const chunk of stream as any) {
      const text = dec.decode(chunk, { stream: true });
      if (!text) continue;
      chunks.push(text);
      opts.onChunk?.({ stream: name, text });
    }
  };

  try {
    await Promise.all([read(proc.stdout, "stdout"), read(proc.stderr, "stderr"), proc.exited]);
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener("abort", onAbort);
  }

  const exitCode = proc.exitCode;
  const raw = chunks.join("").trim();
  const prefix = timedOut ? `timed out after ${opts.timeoutMs ?? 60_000}ms\n` : exitCode && exitCode !== 0 ? `exit ${exitCode}\n` : "";
  return {
    ok: !timedOut && exitCode === 0,
    output: clip(prefix + (raw || "(no output)")),
    exitCode,
    durationMs: Date.now() - started,
    timedOut,
  };
}
