// Per-tab setup script. When a new tab's worktree is created, git brings only
// the TRACKED files — node_modules, build output, generated code, and .env do
// NOT come along, so a fresh worktree often can't build or run. A committable
// `.gearbox/setup` script (tracked, so it rides into every worktree checkout)
// bootstraps the worktree: `bun install`, codegen, whatever the project needs.
//
// Trust: this runs arbitrary shell from the repo. That's the SAME trust gearbox
// already extends to `.gearbox/plugins/*.ts` (imported and executed on open) and
// `.gearbox/mcp.json` — opening a repo already runs its `.gearbox/` code. So
// there is no separate gate here; a unified `.gearbox/` trust model is future
// work that should cover plugins + mcp + setup together, not setup alone.
import { existsSync, statSync, constants } from "node:fs";
import { join } from "node:path";
import { runShellStream } from "./shell.ts";

/** Path to a repo's setup script (whether or not it exists). */
export function setupScriptPath(root: string): string {
  return join(root, ".gearbox", "setup");
}

/** True when the repo defines a `.gearbox/setup` script. Pure (fs stat only). */
export function hasSetup(root: string): boolean {
  try {
    return statSync(setupScriptPath(root)).isFile();
  } catch {
    return false;
  }
}

/** True when the file at `path` has any execute bit set. */
function isExecutable(path: string): boolean {
  try {
    const m = statSync(path).mode;
    return (m & (constants.S_IXUSR | constants.S_IXGRP | constants.S_IXOTH)) !== 0;
  } catch {
    return false;
  }
}

/**
 * Run the worktree's `.gearbox/setup` in the background (the caller does not
 * await it on the hot path). cwd is the worktree so installs land in the right
 * tree. Sandbox is OFF: setup is user-authored project config (like a plugin)
 * and legitimately needs network + writes. Honors an executable script's shebang
 * (`./.gearbox/setup`); otherwise runs it under `sh`.
 */
export async function runSetup(
  worktreeDir: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ ok: boolean; output: string }> {
  const script = setupScriptPath(worktreeDir);
  if (!existsSync(script)) return { ok: true, output: "" }; // nothing to do
  const rel = join(".gearbox", "setup");
  const command = isExecutable(script) ? `"./${rel}"` : `sh "${rel}"`;
  const r = await runShellStream(command, {
    cwd: worktreeDir,
    sandbox: false,
    timeoutMs: opts.timeoutMs ?? 300_000, // installs can be slow; 5 min ceiling
    signal: opts.signal,
  });
  return { ok: r.ok, output: r.output };
}
