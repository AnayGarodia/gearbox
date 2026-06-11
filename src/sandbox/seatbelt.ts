// macOS Seatbelt backend: renders a SandboxPolicy into a sandbox-exec profile
// and wraps an argv with it. sandbox-exec is "deprecated" as a third-party API
// but is what Codex CLI, Chrome, and Bazel ship on; the binary is present on
// every shipping macOS. All Seatbelt specifics are isolated in this module so a
// future replacement (Sandbox.framework, endpoint security) is a local change.
//
// Profile shape (mirrors Codex's workspace-write): deny by default, read
// everywhere (toolchains live in /usr, ~/.bun, /opt), write only to the
// workspace + tmp + ~/.gearbox + tty devices, network denied unless the policy
// allows it. Children of the sandboxed shell inherit the policy, so pipelines
// and subprocesses are covered.
import { existsSync } from "node:fs";
import type { SandboxPolicy } from "./policy.ts";
import { baseWritePaths } from "./policy.ts";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export function sandboxAvailable(platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = existsSync): boolean {
  return platform === "darwin" && exists(SANDBOX_EXEC);
}

/** Escape a path for inclusion in a Seatbelt double-quoted string literal. */
export function escapeSeatbeltString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

const subpath = (p: string) => `(subpath "${escapeSeatbeltString(p)}")`;

export function generateSeatbeltProfile(policy: SandboxPolicy, opts: { gearboxHome?: string; tmp?: string } = {}): string {
  const lines: string[] = [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)",
    "(allow process-exec)",
    "(allow signal (target same-sandbox))",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow file-read*)",
    "(allow file-ioctl)",
  ];
  // Terminal + null devices stay writable in every mode so shells can function.
  const devices = ['(literal "/dev/null")', '(literal "/dev/stdout")', '(literal "/dev/stderr")', '(literal "/dev/dtracehelper")', '(regex #"^/dev/tty")', '(regex #"^/dev/fd/")'];
  if (policy.mode === "workspace-write") {
    const paths = [policy.workspace, ...baseWritePaths(opts), ...policy.extraWritePaths];
    lines.push(`(allow file-write*\n  ${[...new Set(paths)].map(subpath).join("\n  ")}\n  ${devices.join(" ")})`);
  } else {
    // read-only: nothing writable but the devices.
    lines.push(`(allow file-write* ${devices.join(" ")})`);
  }
  if (policy.network) {
    lines.push("(allow network*)", "(allow system-socket)");
  } else {
    lines.push("(deny network*)");
    // Local DNS/mDNSResponder lookups still resolve through mach, already denied
    // by (deny default); nothing extra needed.
  }
  return lines.join("\n");
}

/**
 * Wrap an argv in sandbox-exec per the policy. Identity when the policy is off
 * or the platform lacks a backend — callers can use it unconditionally.
 */
export function wrapWithSandbox(
  argv: string[],
  policy: SandboxPolicy,
  opts: { platform?: NodeJS.Platform; exists?: (p: string) => boolean; gearboxHome?: string; tmp?: string } = {},
): string[] {
  if (policy.mode === "off") return argv;
  if (!sandboxAvailable(opts.platform ?? process.platform, opts.exists ?? existsSync)) return argv;
  return [SANDBOX_EXEC, "-p", generateSeatbeltProfile(policy, opts), ...argv];
}
