// Sandbox policy model — platform-neutral. Pure decisions about WHAT the
// sandbox allows (mode, workspace, network, extra write paths); the per-OS
// mechanism (seatbelt.ts on macOS, a future bwrap builder on Linux) renders a
// policy into an actual sandbox invocation. Keeping the policy separate means
// the Linux backend reuses every decision here unchanged.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";

// Seatbelt (and Landlock) match RESOLVED paths; /tmp and /var are symlinks on
// macOS, so an unresolved workspace would silently deny every write inside it.
const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

export type SandboxMode = "off" | "read-only" | "workspace-write";

export interface SandboxPolicy {
  mode: SandboxMode;
  /** Absolute workspace root the agent may write under (workspace-write mode). */
  workspace: string;
  /** Allow outbound network from sandboxed commands. */
  network: boolean;
  /** Extra absolute paths that must stay writable (e.g. a worktree's real gitdir). */
  extraWritePaths: string[];
}

const MODES: SandboxMode[] = ["off", "read-only", "workspace-write"];

export function parseSandboxMode(v: string | undefined | null): SandboxMode | null {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  if (s === "on") return "workspace-write"; // friendly alias
  return (MODES as string[]).includes(s) ? (s as SandboxMode) : null;
}

/** Minimal structural view of Prefs so this module stays decoupled from the UI layer. */
export interface SandboxPrefs {
  sandbox?: SandboxMode;
  sandboxNetwork?: boolean;
}

/**
 * Resolve the effective policy. Precedence: env (GEARBOX_SANDBOX /
 * GEARBOX_SANDBOX_NETWORK) > prefs > platform default ("off" everywhere for
 * now; flipped to workspace-write on darwin when the wiring lands).
 */
export function resolveSandboxPolicy(
  prefs: SandboxPrefs,
  env: Record<string, string | undefined>,
  cwd: string,
  opts: { platform?: NodeJS.Platform; gearboxHome?: string; hasBackend?: (platform: NodeJS.Platform) => boolean } = {},
): SandboxPolicy {
  const platform = opts.platform ?? process.platform;
  // Backend presence: seatbelt ships on every macOS; Linux needs bwrap installed.
  // Injectable so tests never probe the host filesystem.
  const hasBackend = opts.hasBackend ?? defaultHasBackend;
  const envMode = parseSandboxMode(env.GEARBOX_SANDBOX);
  // Default: on (workspace-write) where a backend exists, off elsewhere.
  const platformDefault: SandboxMode = hasBackend(platform) ? "workspace-write" : "off";
  const mode: SandboxMode = envMode ?? prefs.sandbox ?? platformDefault;
  const envNet = env.GEARBOX_SANDBOX_NETWORK?.trim().toLowerCase();
  const network = envNet === "allow" || envNet === "on" ? true : envNet === "deny" || envNet === "off" ? false : (prefs.sandboxNetwork ?? false);
  const workspace = real(cwd);
  // Degrade to off where no backend exists so callers never spawn a wrapper
  // that does not exist on the host.
  const effective = hasBackend(platform) ? mode : "off";
  return { mode: effective, workspace, network, extraWritePaths: gitDirWritePaths(workspace) };
}

// darwin always has sandbox-exec; linux counts only when bwrap is installed.
// Path list mirrors bwrap.ts BWRAP_CANDIDATES (kept literal here to avoid an
// import cycle between policy and backend modules).
function defaultHasBackend(platform: NodeJS.Platform): boolean {
  if (platform === "darwin") return true;
  if (platform === "linux") return ["/usr/bin/bwrap", "/usr/local/bin/bwrap", "/bin/bwrap"].some((p) => existsSync(p));
  return false;
}

/**
 * A linked worktree's `.git` is a pointer FILE ("gitdir: /path/to/repo/.git/worktrees/x");
 * git writes to that real gitdir (index, locks) live outside the workspace, so it
 * must stay writable or every sandboxed `git add/commit` fails. Best-effort sync read.
 */
export function gitDirWritePaths(workspace: string, read: (p: string) => string = (p) => readFileSync(p, "utf8")): string[] {
  try {
    const pointer = read(join(workspace, ".git"));
    const m = /^gitdir:\s*(.+)\s*$/m.exec(pointer);
    if (!m) return [];
    const gitdir = isAbsolute(m[1]!) ? m[1]! : resolve(workspace, m[1]!);
    // Allow the whole common dir (…/.git), not just the worktree subdir — git
    // writes shared refs/objects there too.
    const common = gitdir.includes(`${join("/", ".git", "worktrees")}`) || /\/\.git\/worktrees\//.test(gitdir) ? resolve(gitdir, "..", "..") : gitdir;
    // Seatbelt matches resolved paths — a main repo under a symlinked prefix
    // (e.g. /tmp/... → /private/tmp/...) needs the real spelling, same as
    // workspace/tmp/home.
    return [real(resolve(common))];
  } catch {
    return []; // regular repo (.git is a directory, inside the workspace) or no repo
  }
}

/** The directories every policy keeps writable besides the workspace. */
export function baseWritePaths(opts: { gearboxHome?: string; tmp?: string } = {}): string[] {
  const home = opts.gearboxHome || process.env.GEARBOX_HOME || join(homedir(), ".gearbox");
  const t = opts.tmp ?? tmpdir();
  const set = new Set<string>(["/tmp", "/private/tmp", real(t), real(home)]);
  return [...set];
}

/**
 * Does this failed command output look like the sandbox blocked it (rather
 * than an ordinary failure)? Used to annotate the result for the model and to
 * offer a permission-gated unsandboxed re-run. False positives only cost one
 * extra prompt, so the heuristic leans inclusive.
 */
export function looksLikeSandboxDenial(output: string, exitCode: number | null): { denied: boolean; kind: "network" | "write" | null } {
  if (exitCode === 0) return { denied: false, kind: null };
  const o = output.slice(0, 20_000);
  const network =
    /network is unreachable|could not resolve|couldn't resolve|getaddrinfo|temporary failure in name resolution|connection refused.*proxy|no route to host|failed to connect|connect(ion)? timed out|ENETUNREACH|EAI_AGAIN|ENOTFOUND/i.test(
      o,
    );
  if (network) return { denied: true, kind: "network" };
  const write = /operation not permitted|sandbox-exec.*denied|deny(ed)?[^\n]*file-write|read-only file system|EPERM|EROFS/i.test(o);
  if (write) return { denied: true, kind: "write" };
  return { denied: false, kind: null };
}
