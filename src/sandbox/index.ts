// Sandbox facade. Policy decisions live in policy.ts (platform-neutral);
// seatbelt.ts is the macOS backend. A Linux bwrap backend slots in beside it.
export type { SandboxMode, SandboxPolicy, SandboxPrefs } from "./policy.ts";
export { resolveSandboxPolicy, parseSandboxMode, looksLikeSandboxDenial, gitDirWritePaths, baseWritePaths } from "./policy.ts";
export { wrapWithSandbox, generateSeatbeltProfile, sandboxAvailable, escapeSeatbeltString, SANDBOX_EXEC } from "./seatbelt.ts";
