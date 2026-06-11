// A persistent shell session: one long-lived /bin/sh whose state (cwd, exported
// AND plain variables, shell options) carries across calls — so `cd`, `export`,
// and `source` do what users expect instead of resetting every command, the way a
// fresh-subprocess-per-call shell does.
//
// Completion + exit code are framed with a per-command sentinel printed to both
// stdout and stderr; we read each stream until its sentinel, then hand back the
// body with the framing stripped. The sentinel parser is pure and tested.
import { spawnProc, type Proc } from "./proc.ts";

const CAP = 60_000;
const clip = (s: string) => (s.length > CAP ? s.slice(0, CAP) + `\n… [clipped ${s.length - CAP} chars]` : s);

export interface SessionRunResult {
  ok: boolean;
  output: string;
  exitCode: number | null;
  timedOut?: boolean;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Look for the completion frame `<sentinel> <exitcode>` at the start of a line.
 * Returns the command body (everything the command printed, up to and including
 * the newline before the frame) and the parsed exit code, or null if the frame
 * has not arrived yet.
 */
export function parseFramed(buf: string, sentinel: string): { body: string; exitCode: number } | null {
  const re = new RegExp("(^|\\n)" + escapeRe(sentinel) + " (-?\\d+)");
  const m = re.exec(buf);
  if (!m) return null;
  const body = buf.slice(0, m.index + (m[1] ? m[1].length : 0));
  return { body, exitCode: parseInt(m[2]!, 10) };
}

export class ShellSession {
  private proc: Proc | null = null;
  private outBuf = "";
  private errBuf = "";
  private seq = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;
  // Called when the shell process exits (e.g. the user ran `exit`); lets the
  // in-flight command settle with the shell's exit code instead of hanging.
  private onProcExit: ((code: number | null) => void) | null = null;

  // `cwd` is the shell's initial working dir (a worktree root for an isolated
  // sub-agent); subsequent `cd`s within the session move from there. `argv`
  // lets the caller wrap the shell (e.g. sandbox-exec) — the session itself
  // stays sandbox-agnostic.
  constructor(
    private cwd?: string,
    private argv: string[] = ["/bin/sh"],
  ) {}

  private start() {
    if (this.proc || this.closed) return;
    const proc = spawnProc(this.argv, { cwd: this.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.proc = proc;
    proc.stdout?.on("data", (c: Buffer) => {
      this.outBuf += c.toString("utf8");
      this.pump?.();
    });
    proc.stderr?.on("data", (c: Buffer) => {
      this.errBuf += c.toString("utf8");
      this.pump?.();
    });
    void proc.exited.then((code) => {
      if (this.proc === proc) this.proc = null; // allow a fresh restart next run
      this.onProcExit?.(code);
    });
  }

  // Set while a command is in flight; called whenever new data lands.
  private pump: (() => void) | null = null;

  run(command: string, opts: { timeoutMs?: number; signal?: AbortSignal; onChunk?: (c: { stream: "stdout" | "stderr"; text: string }) => void } = {}): Promise<SessionRunResult> {
    const exec = () => this.execOne(command, opts);
    const next = this.chain.then(exec, exec);
    this.chain = next.catch(() => {});
    return next;
  }

  private execOne(command: string, opts: { timeoutMs?: number; signal?: AbortSignal; onChunk?: (c: { stream: "stdout" | "stderr"; text: string }) => void }): Promise<SessionRunResult> {
    this.start();
    const proc = this.proc;
    if (!proc || this.closed) return Promise.resolve({ ok: false, output: "shell session is not available", exitCode: null });

    const sentinel = `<<GBX:${++this.seq}>>`;
    // Fresh buffers for this command (the previous frame was consumed).
    this.outBuf = "";
    this.errBuf = "";
    let outSeen = 0;
    let errSeen = 0;

    return new Promise<SessionRunResult>((resolve) => {
      let settled = false;
      let outFrame: { body: string; exitCode: number } | null = null;
      let errDone = false;

      const finish = (r: SessionRunResult) => {
        if (settled) return;
        settled = true;
        this.pump = null;
        this.onProcExit = null;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        resolve(r);
      };

      // The user's command may end the shell itself (`exit`, `kill $$`). When the
      // process dies before the frame prints, report what we captured plus the
      // shell's own exit code; start() already cleared this.proc so the next run
      // spins up a fresh shell.
      this.onProcExit = (code) => {
        if (outFrame) return; // normal completion already framed
        const body = [this.outBuf.trimEnd(), this.errBuf.trimEnd()].filter(Boolean).join("\n");
        finish({ ok: code === 0, output: clip((code ? `exit ${code}\n` : "") + (body || "(no output)")), exitCode: code });
      };

      // Stream only bytes that can't be (part of) the completion frame: up to the
      // frame body once seen, else the buffer minus a tail wide enough to hold a
      // partial sentinel. This keeps the framing out of the live UI output.
      const guard = sentinel.length + 8;
      const safeEnd = (buf: string, frame: { body: string } | null) => (frame ? frame.body.length : Math.max(0, buf.length - guard));
      this.pump = () => {
        if (settled) return;
        if (!outFrame) outFrame = parseFramed(this.outBuf, sentinel);
        if (!errDone) errDone = parseFramed(this.errBuf, sentinel) != null;
        if (opts.onChunk) {
          const oEnd = safeEnd(this.outBuf, outFrame);
          if (oEnd > outSeen) {
            opts.onChunk({ stream: "stdout", text: this.outBuf.slice(outSeen, oEnd) });
            outSeen = oEnd;
          }
          const eEnd = safeEnd(this.errBuf, errDone ? parseFramed(this.errBuf, sentinel) : null);
          if (eEnd > errSeen) {
            opts.onChunk({ stream: "stderr", text: this.errBuf.slice(errSeen, eEnd) });
            errSeen = eEnd;
          }
        }
        if (outFrame && errDone) {
          const errBody = parseFramed(this.errBuf, sentinel)!.body;
          const merged = [outFrame.body.replace(/\n+$/, ""), errBody.replace(/\n+$/, "")].filter(Boolean).join("\n");
          const prefix = outFrame.exitCode !== 0 ? `exit ${outFrame.exitCode}\n` : "";
          finish({ ok: outFrame.exitCode === 0, output: clip(prefix + (merged || "(no output)")), exitCode: outFrame.exitCode });
        }
      };

      const timer = setTimeout(() => {
        this.kill();
        finish({ ok: false, output: clip(`timed out after ${opts.timeoutMs ?? 60_000}ms`), exitCode: null, timedOut: true });
      }, opts.timeoutMs ?? 60_000);

      const onAbort = () => {
        this.kill();
        finish({ ok: false, output: "(interrupted)", exitCode: null });
      };
      opts.signal?.addEventListener("abort", onAbort);

      // Run the command, then frame the result on both streams from a single
      // captured exit code so stdout and stderr report the same status.
      const frame = `__gbx=$?; printf '\\n%s %s\\n' '${sentinel}' "$__gbx"; printf '\\n%s %s\\n' '${sentinel}' "$__gbx" 1>&2\n`;
      proc.stdin?.write(command + "\n" + frame);
      this.pump();
    });
  }

  private kill() {
    try {
      this.proc?.kill();
    } catch {
      /* already gone */
    }
    this.proc = null;
  }

  close() {
    this.closed = true;
    try {
      this.proc?.stdin?.end();
    } catch {
      /* ignore */
    }
    this.kill();
  }
}
