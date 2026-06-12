// Linux bubblewrap backend: renders a SandboxPolicy into a bwrap argv. The
// policy layer (policy.ts) stays platform-neutral; this module mirrors
// seatbelt.ts's contract — pure argv construction, identity when unavailable.
//
// Shape (mirrors the seatbelt workspace-write profile): the whole filesystem
// is bound read-only, then the workspace + tmp + ~/.gearbox + extra write
// paths are re-bound writable on top. Network is cut with --unshare-net
// unless the policy allows it. --die-with-parent ensures no orphan escapes
// the session. Children inherit the namespace, so pipelines are covered.
import { existsSync } from "node:fs";
import type { SandboxPolicy } from "./policy.ts";
import { baseWritePaths } from "./policy.ts";

export const BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/usr/local/bin/bwrap", "/bin/bwrap"];

export function bwrapPath(exists: (p: string) => boolean = existsSync): string | null {
  for (const p of BWRAP_CANDIDATES) if (exists(p)) return p;
  return null;
}

export function bwrapAvailable(platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = existsSync): boolean {
  return platform === "linux" && bwrapPath(exists) !== null;
}

/**
 * Build the bwrap argv for a policy. Pure: no filesystem checks beyond what
 * the caller injected into the policy. Returns null for mode "off".
 */
export function generateBwrapArgs(policy: SandboxPolicy, opts: { gearboxHome?: string; tmp?: string } = {}): string[] | null {
  if (policy.mode === "off") return null;
  const args: string[] = [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/run",
    "--die-with-parent",
    // TIOCSTI defense: without a new session a sandboxed process can inject
    // keystrokes into the controlling terminal (bwrap's own manpage warning) —
    // an escape seatbelt has no analogue for. Interactive REPLs inside the
    // sandbox lose job control, which run_shell never offers anyway.
    "--new-session",
  ];
  if (policy.mode === "workspace-write") {
    const paths = [...new Set([policy.workspace, ...baseWritePaths(opts), ...policy.extraWritePaths])]
      // /private/* are darwin spellings from baseWritePaths; they don't exist on Linux.
      .filter((p) => !p.startsWith("/private"));
    for (const p of paths) args.push("--bind-try", p, p);
  }
  if (!policy.network) args.push("--unshare-net");
  return args;
}

/**
 * Wrap an argv in bwrap per the policy. Identity when the policy is off or
 * bwrap is missing — callers can use it unconditionally (same contract as
 * wrapWithSandbox in seatbelt.ts).
 */
export function wrapWithBwrap(
  argv: string[],
  policy: SandboxPolicy,
  opts: { platform?: NodeJS.Platform; exists?: (p: string) => boolean; gearboxHome?: string; tmp?: string } = {},
): string[] {
  if (policy.mode === "off") return argv;
  const bin = (opts.platform ?? process.platform) === "linux" ? bwrapPath(opts.exists ?? existsSync) : null;
  if (!bin) return argv;
  const args = generateBwrapArgs(policy, opts);
  if (!args) return argv;
  return [bin, ...args, ...argv];
}
