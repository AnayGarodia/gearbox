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
import { spawnSync } from "node:child_process";
import type { SandboxPolicy } from "./policy.ts";
import { baseWritePaths } from "./policy.ts";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

let smokeCache: boolean | null = null;

function sandboxSmoke(): boolean {
  if (smokeCache != null) return smokeCache;
  try {
    const r = spawnSync(SANDBOX_EXEC, ["-p", "(version 1)\n(allow default)", "/usr/bin/true"], {
      stdio: "ignore",
      timeout: 2_000,
    });
    smokeCache = r.status === 0;
  } catch {
    smokeCache = false;
  }
  return smokeCache;
}

export function sandboxAvailable(platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = existsSync): boolean {
  if (platform !== "darwin" || !exists(SANDBOX_EXEC)) return false;
  // Tests inject a fake `exists` predicate to exercise pure dispatch without
  // spawning the host binary. Real runtime checks also verify that this process
  // may actually apply a profile; some managed macOS contexts ship
  // sandbox-exec but return "sandbox_apply: Operation not permitted".
  return exists === existsSync ? sandboxSmoke() : true;
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
    // The blanket (allow mach-lookup) above would still let a process reach
    // mDNSResponder & friends, which do DNS on its behalf — a covert network
    // channel under (deny network*). SBPL is last-match-wins, so deny the
    // network-helper services explicitly here.
    lines.push(
      '(deny mach-lookup (global-name "com.apple.mDNSResponder") (global-name "com.apple.dnssd.service") (global-name "com.apple.networkd") (global-name "com.apple.nehelper") (global-name "com.apple.nesessionmanager") (global-name "com.apple.usymptomsd"))',
    );
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
