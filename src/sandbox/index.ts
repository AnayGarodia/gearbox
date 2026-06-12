// Sandbox facade. Policy decisions live in policy.ts (platform-neutral);
// seatbelt.ts is the macOS backend, bwrap.ts the Linux one. wrapWithSandbox
// here is the platform dispatcher — callers never pick a backend.
import type { SandboxPolicy } from "./policy.ts";
import { wrapWithSandbox as wrapWithSeatbelt } from "./seatbelt.ts";
import { wrapWithBwrap } from "./bwrap.ts";

export type { SandboxMode, SandboxPolicy, SandboxPrefs } from "./policy.ts";
export { resolveSandboxPolicy, parseSandboxMode, looksLikeSandboxDenial, gitDirWritePaths, baseWritePaths } from "./policy.ts";
export { generateSeatbeltProfile, sandboxAvailable, escapeSeatbeltString, SANDBOX_EXEC } from "./seatbelt.ts";
export { wrapWithBwrap, generateBwrapArgs, bwrapAvailable } from "./bwrap.ts";

/**
 * Wrap an argv with the platform's sandbox backend per the policy. Identity
 * when the policy is off or the platform lacks a backend — callers can use it
 * unconditionally.
 */
export function wrapWithSandbox(
  argv: string[],
  policy: SandboxPolicy,
  opts: { platform?: NodeJS.Platform; exists?: (p: string) => boolean; gearboxHome?: string; tmp?: string } = {},
): string[] {
  const platform = opts.platform ?? process.platform;
  if (platform === "darwin") return wrapWithSeatbelt(argv, policy, { ...opts, platform });
  if (platform === "linux") return wrapWithBwrap(argv, policy, { ...opts, platform });
  return argv;
}
