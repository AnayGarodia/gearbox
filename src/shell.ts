/**
 * shell.ts - Shared shell execution layer used by both the `run_shell` tool and
 * the interactive `!<command>` prefix.
 *
 * Design notes
 * ------------
 * - Commands are intentionally run through a shell (not execFile with an arg
 *   array). That is the whole point of a coding-agent shell tool: the caller
 *   needs pipelines, redirections, shell built-ins, and multi-statement one-
 *   liners, exactly like Claude Code's Bash tool or a terminal.
 * - Safety therefore belongs in a permission/confirmation gate (see
 *   permission.ts and requestPermission), not in restricting the shell syntax.
 * - Output is hard-capped at 60 000 characters (CAP). Beyond that limit the
 *   text is truncated and a "clipped N chars" notice is appended, so the model
 *   context does not fill with megabytes of log output.
 * - runShell (sync, execSync) exists for lightweight callers that do not need
 *   streaming or a persistent session (e.g. one-off checks in scripts). It
 *   captures stdout and stderr together, applies the cap, and never throws.
 * - runShellStream is the primary path for the agent: it backs a persistent
 *   ShellSession so that `cd`, `export`, and `source` survive across calls.
 *   Sessions are keyed by working directory so parallel sub-agents running in
 *   isolated git worktrees each get their own shell state.
 */
import { execSync } from "node:child_process";
import { ShellSession } from "./shell-session.ts";
import { resolveSandboxPolicy, wrapWithSandbox, type SandboxPolicy } from "./sandbox/index.ts";
import { loadPrefs } from "./ui/prefs.ts";

/** Maximum characters returned to callers. Excess output is truncated. */
const CAP = 60_000;
const clip = (s: string) => (s.length > CAP ? s.slice(0, CAP) + `\n… [clipped ${s.length - CAP} chars]` : s);

/** A single chunk of live output emitted while a command is still running. */
export interface ShellChunk {
  stream: "stdout" | "stderr";
  text: string;
}

/** The final result returned once a command (or session command) completes. */
export interface ShellResult {
  ok: boolean;
  output: string;
  exitCode: number | null;
  durationMs: number;
  timedOut?: boolean;
}

/**
 * Synchronous, fire-and-forget shell runner.
 *
 * Uses execSync rather than a persistent session because callers here do not
 * need state to survive across invocations. The tradeoffs vs runShellStream:
 *   - Simpler call-site (no async, no session management).
 *   - No streaming: output is returned only after the process exits.
 *   - Each call starts a fresh shell, so `cd` and variable assignments do not
 *     carry forward.
 *   - Hard timeout of 60 s and an 8 MiB buffer guard against runaway processes.
 *
 * Never throws. Non-zero exit codes are captured in ok=false and the combined
 * stdout/stderr is returned in output.
 */
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

/**
 * Persistent shell sessions, keyed by working directory.
 *
 * Using a persistent session means `cd`, `export`, and `source` carry across
 * consecutive commands, which is what users expect from an interactive shell.
 * A fresh-subprocess-per-call model would reset all of that state every time.
 *
 * One session per unique cwd means:
 *   - The main agent and any sub-agent sharing the same worktree share a shell.
 *   - A sub-agent given its own git worktree root (via opts.cwd in
 *     runShellStream) gets an isolated session and cannot interfere with others.
 *   - Sessions are created lazily on first use and restarted automatically if a
 *     previous command killed the shell (e.g. via `exit` or a timeout kill).
 */
const sessions = new Map<string, ShellSession>();

/** The effective sandbox policy for a workspace root (env > prefs > off). */
export function sandboxPolicyFor(root: string, sandbox: boolean, networkOverride?: boolean): SandboxPolicy {
  const policy = resolveSandboxPolicy(loadPrefs(), process.env, root);
  const network = networkOverride ?? policy.network;
  return sandbox ? { ...policy, network } : { ...policy, mode: "off" };
}

// Sessions are keyed by cwd AND sandbox shape so a sandboxed and an
// unsandboxed (or network-allowed) shell for the same root never collide.
const sessionKey = (root: string, p: SandboxPolicy) => `${root}#${p.mode}${p.mode !== "off" && p.network ? "+net" : ""}`;

function shellSession(cwd: string | undefined, sandbox: boolean, networkOverride?: boolean): ShellSession {
  const root = cwd ?? process.cwd();
  const policy = sandboxPolicyFor(root, sandbox, networkOverride);
  const key = sessionKey(root, policy);
  let session = sessions.get(key);
  if (!session) {
    session = new ShellSession(root, wrapWithSandbox(["/bin/sh"], policy));
    sessions.set(key, session);
  }
  return session;
}

/**
 * Close and forget every cached session — required after a sandbox mode or
 * network toggle so the next command spawns a shell under the new profile.
 */
export function resetShellSessions(): void {
  for (const s of sessions.values()) s.close();
  sessions.clear();
}

/**
 * Streaming shell runner backed by a persistent session. This is the primary
 * execution path for the run_shell tool and the `!` REPL prefix.
 *
 * Key behaviours callers should know:
 *   - opts.cwd scopes the session: pass a worktree root to keep parallel
 *     sub-agent shells isolated from each other.
 *   - opts.onChunk fires with interleaved stdout/stderr chunks while the
 *     command runs, so the UI can display live output.
 *   - opts.timeoutMs defaults to 60 000 ms. A timed-out session is evicted
 *     from the cache, so the next call to the same cwd starts a fresh shell.
 *   - opts.signal allows callers to abort via AbortController (e.g. on SIGINT).
 *   - Output is capped at 60 000 characters before being returned to callers.
 *   - The returned ShellResult.ok reflects the command's exit code (0 = true).
 */
export async function runShellStream(
  command: string,
  opts: { signal?: AbortSignal; timeoutMs?: number; onChunk?: (chunk: ShellChunk) => void; cwd?: string; sandbox?: boolean; sandboxNetwork?: boolean } = {},
): Promise<ShellResult> {
  const started = Date.now();
  const root = opts.cwd ?? process.cwd();
  const sandbox = opts.sandbox ?? true; // agent commands sandbox by policy; `!cmd` opts out (user is the principal)
  const r = await shellSession(root, sandbox, opts.sandboxNetwork).run(command, {
    timeoutMs: opts.timeoutMs ?? 60_000,
    signal: opts.signal,
    onChunk: opts.onChunk,
  });
  // A dead session (e.g. after a timeout kill) is dropped so the next call starts fresh.
  if (r.timedOut) sessions.delete(sessionKey(root, sandboxPolicyFor(root, sandbox, opts.sandboxNetwork)));
  return {
    ok: r.ok,
    output: clip(r.output || "(no output)"),
    exitCode: r.exitCode,
    durationMs: Date.now() - started,
    timedOut: r.timedOut,
  };
}
