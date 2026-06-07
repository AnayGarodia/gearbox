// Clean subscription usage probe — gets the EXACT 5-hour / weekly utilization for
// CLI-backed subscription accounts WITHOUT ever reading the vendor OAuth token.
//
// The trick: the vendor CLI already fetches its own usage (with its own token,
// exactly as designed) and surfaces it to user scripts. We let it do that and
// read the result — no token, no usage endpoint, no User-Agent spoofing.
//
//  • Claude: the interactive statusLine receives `rate_limits.{five_hour,seven_day}`
//    (each {used_percentage, resets_at}) AFTER the session does a turn. We run the
//    real `claude` binary in a PTY with a transient `--settings` statusLine overlay
//    that writes the JSON to a file, send a one-word prompt to populate it, read it.
//  • Codex: interactive sessions log a `token_count` event whose `rate_limits`
//    (primary = 5h, secondary = weekly) is fully populated, to a rollout JSONL.
//    `codex exec` (what we run for turns) reports null, so we read the newest
//    rollout the user's own Codex sessions already wrote — turn-free.
//
// Everything degrades to `null` on any failure; callers fall back to the near-limit
// data the `-p`/exec stream already provides. Verified on macOS (claude 2.1.168,
// codex 0.x); see the probe validation in the feature's plan.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnProc, which, type Proc } from "../proc.ts";
import type { Account } from "./types.ts";
import type { RateSnapshot } from "./usage.ts";

const home = () => process.env.GEARBOX_HOME || join(homedir(), ".gearbox");
const probeDir = () => join(home(), "probe");

// A snapshot the probe produces — carries its own observation time so a stale
// Codex rollout reads honestly as "observed 2h ago" rather than "just now".
export type ProbeSnapshot = Omit<RateSnapshot, "at"> & { at?: number };

// ── pure parsers (unit-tested against fixtures) ───────────────────────────────

/** Claude statusLine `rate_limits` → snapshots. Shape per Claude Code ≥2.1.x:
 *  { five_hour: {used_percentage, resets_at}, seven_day: {...} } (percent 0–100,
 *  resets_at unix seconds). Either window may be absent. */
export function parseClaudeRateLimits(rl: any): ProbeSnapshot[] {
  if (!rl || typeof rl !== "object") return [];
  const out: ProbeSnapshot[] = [];
  for (const [key, type] of [["five_hour", "five_hour"], ["seven_day", "seven_day"]] as const) {
    const w = rl[key];
    if (!w || typeof w !== "object") continue;
    const pct = num(w.used_percentage ?? w.utilization);
    if (pct == null) continue;
    // used_percentage is 0–100; utilization elsewhere in the app is 0–1.
    out.push({ type, utilization: clamp01(pct / 100), resetsAt: num(w.resets_at ?? w.resetsAt) });
  }
  return out;
}

/** Codex rollout `rate_limits` → snapshots. Shape:
 *  { primary:{used_percent, window_minutes, resets_at}, secondary:{...} }.
 *  window_minutes ≈ 300 → five_hour, ≈ 10080 → seven_day (fall back by size). */
export function parseCodexRateLimits(rl: any, observedAt?: number): ProbeSnapshot[] {
  if (!rl || typeof rl !== "object") return [];
  const out: ProbeSnapshot[] = [];
  for (const slot of ["primary", "secondary"] as const) {
    const w = rl[slot];
    if (!w || typeof w !== "object") continue;
    const pct = num(w.used_percent ?? w.used_percentage ?? w.utilization);
    if (pct == null) continue;
    const mins = num(w.window_minutes);
    const type = windowType(mins, slot);
    out.push({ type, utilization: clamp01(pct / 100), resetsAt: num(w.resets_at ?? w.resetsAt), at: observedAt });
  }
  return out;
}

function windowType(windowMinutes: number | undefined, slot: "primary" | "secondary"): string {
  if (windowMinutes != null) return windowMinutes <= 24 * 60 ? "five_hour" : "seven_day";
  return slot === "primary" ? "five_hour" : "seven_day";
}

// Recursively find a `rate_limits` object that has a usable window. Codex nests it
// under a `token_count`/`payload` event; this is robust to the exact wrapper.
export function findRateLimits(obj: any, depth = 0): any | null {
  if (!obj || typeof obj !== "object" || depth > 6) return null;
  if (obj.rate_limits && typeof obj.rate_limits === "object" && (obj.rate_limits.primary || obj.rate_limits.secondary)) {
    return obj.rate_limits;
  }
  for (const k of Object.keys(obj)) {
    const found = findRateLimits(obj[k], depth + 1);
    if (found) return found;
  }
  return null;
}

function num(x: any): number | undefined {
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}
function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

// ── Claude probe (statusLine via PTY) ─────────────────────────────────────────

function claudeConfigDir(account: Account): string {
  const lp = account.auth.kind === "cli" ? account.auth.loginProfile : undefined;
  return lp || join(homedir(), ".claude");
}

// Write the tiny capture script once. It is self-contained (no imports beyond
// node core) so it works regardless of how Gearbox itself was bundled/installed.
// The output path comes as argv[2] (claude does NOT forward our env to the
// statusLine subprocess, so env can't be relied on); env is a fallback.
function ensureCaptureScript(): string {
  // .cjs (CommonJS) so `require` is defined — a .mjs would make require undefined.
  const p = join(probeDir(), "statusline-capture.cjs");
  const body =
    'const out=process.argv[2]||process.env.GEARBOX_USAGE_OUT;' +
    'let s="";process.stdin.on("data",d=>s+=d);' +
    'process.stdin.on("end",()=>{try{const j=JSON.parse(s);' +
    'if(out&&j&&j.rate_limits&&Object.keys(j.rate_limits).length)' +
    'require("fs").writeFileSync(out,JSON.stringify(j.rate_limits));' +
    '}catch(e){}process.stdout.write(" ");});\n';
  try {
    mkdirSync(probeDir(), { recursive: true });
    if (!existsSync(p) || readFileSync(p, "utf8") !== body) writeFileSync(p, body);
  } catch {
    /* best-effort */
  }
  return p;
}

// Merge-safe pre-seed of onboarding + trust so interactive `claude` renders the
// statusLine immediately instead of blocking on theme/trust prompts. Only ADDS
// missing keys — never overwrites the user's real theme/onboarding choices.
function ensureOnboarded(configDir: string, cwd: string): void {
  const f = join(configDir, ".claude.json");
  let d: any = {};
  try {
    if (existsSync(f)) d = JSON.parse(readFileSync(f, "utf8"));
  } catch {
    d = {};
  }
  let changed = false;
  if (d.hasCompletedOnboarding !== true) { d.hasCompletedOnboarding = true; changed = true; }
  if (d.theme == null) { d.theme = "dark"; changed = true; }
  if (d.hasIdeOnboardingBeenShown == null) { d.hasIdeOnboardingBeenShown = true; changed = true; }
  const projects = (d.projects && typeof d.projects === "object") ? d.projects : (d.projects = {});
  const p = (projects[cwd] && typeof projects[cwd] === "object") ? projects[cwd] : (projects[cwd] = {});
  if (p.hasTrustDialogAccepted !== true) { p.hasTrustDialogAccepted = true; changed = true; }
  if (p.hasCompletedProjectOnboarding !== true) { p.hasCompletedProjectOnboarding = true; changed = true; }
  if (!p.projectOnboardingSeenCount) { p.projectOnboardingSeenCount = 1; changed = true; }
  if (changed) {
    try {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(f, JSON.stringify(d, null, 2));
    } catch {
      /* best-effort */
    }
  }
}

// The vendor CLI only renders the statusLine when it owns a real controlling TTY.
// `script(1)` works ONLY when it itself has a TTY — under a plain pipe (how we
// spawn) the child never renders. The portable, dependency-free way to give a
// child a PTY from Node/Bun is a tiny python3 helper (system tool on macOS/Linux).
// It forks claude on a PTY, sends a one-word prompt to make the session do a turn
// (which is what populates rate_limits), and exits once the capture file is written.
function ensurePtyDriver(): string {
  const p = join(probeDir(), "pty-probe.py");
  const body = `import os, pty, sys, time, select, signal
cfg, settings, out, model, timeout, cwd = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], float(sys.argv[5]), sys.argv[6]
env = dict(os.environ)
for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"): env.pop(k, None)
env["CLAUDE_CONFIG_DIR"] = cfg
try: open(out, "w").close()
except Exception: pass
pid, fd = pty.fork()
if pid == 0:
    try: os.chdir(cwd)
    except Exception: pass
    os.execvpe("claude", ["claude", "--settings", settings, "--model", model], env)
else:
    start = time.time()
    nudges = [(6.0, b"hi\\r"), (10.0, b"\\r"), (14.0, b"\\r")]; sent = set()
    def ready():
        try: return os.path.getsize(out) > 0
        except Exception: return False
    while time.time() - start < timeout:
        try: r, _, _ = select.select([fd], [], [], 0.3)
        except Exception: break
        if r:
            try:
                if not os.read(fd, 65536): break
            except OSError: break
        if ready():
            time.sleep(0.4); break
        el = time.time() - start
        for i, (t, k) in enumerate(nudges):
            if i not in sent and el > t:
                try: os.write(fd, k)
                except OSError: pass
                sent.add(i)
    for s in (signal.SIGTERM, signal.SIGKILL):
        try: os.kill(pid, s); time.sleep(0.2)
        except Exception: pass
`;
  try {
    mkdirSync(probeDir(), { recursive: true });
    if (!existsSync(p) || readFileSync(p, "utf8") !== body) writeFileSync(p, body);
  } catch {
    /* best-effort */
  }
  return p;
}

function pythonBin(): string | null {
  return which("python3") ?? which("python");
}

/** Probe one Claude subscription account via the python PTY driver. Null on any
 *  failure (missing python/claude, timeout, no data) — callers fall back to the
 *  near-limit data the `-p` stream already records. */
export async function probeClaudeUsage(account: Account, opts: { timeoutMs?: number; model?: string } = {}): Promise<ProbeSnapshot[] | null> {
  if (account.auth.kind !== "cli") return null;
  const py = pythonBin();
  if (!py || !which("claude")) return null;
  const timeoutMs = opts.timeoutMs ?? 22_000;
  const timeoutSec = Math.max(8, Math.round(timeoutMs / 1000));
  const configDir = claudeConfigDir(account);
  const capture = ensureCaptureScript();
  const driver = ensurePtyDriver();
  const node = which("node") ?? "node";
  const out = join(probeDir(), `${account.id}-claude.json`);
  const settingsFile = join(probeDir(), `${account.id}-statusline.json`);
  // A throwaway working dir so the probe's one-word "hi" turn doesn't clutter the
  // user's real project history (esp. the default ~/.claude account).
  const workCwd = join(probeDir(), "work");
  try {
    mkdirSync(workCwd, { recursive: true });
    if (existsSync(out)) writeFileSync(out, ""); // clear stale
    // Transient statusLine overlay (a settings FILE, not the user's settings.json).
    // The out path is an ARG (claude doesn't forward our env to this subprocess).
    writeFileSync(settingsFile, JSON.stringify({ statusLine: { type: "command", command: `${node} ${capture} ${out}` } }));
  } catch {
    return null;
  }
  ensureOnboarded(configDir, workCwd);

  let proc: Proc;
  try {
    proc = spawnProc([py, driver, configDir, settingsFile, out, opts.model ?? "haiku", String(timeoutSec), workCwd], {
      stdin: "ignore", stdout: "ignore", stderr: "ignore", env: process.env,
    });
  } catch {
    return null;
  }
  // Hard guard: the driver self-limits, but never let a hung child outlive us.
  const guard = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs + 6000);
  try {
    await proc.exited;
  } catch {
    /* ignore */
  } finally {
    clearTimeout(guard);
  }
  try {
    const txt = readFileSync(out, "utf8").trim();
    if (!txt) return null;
    const snaps = parseClaudeRateLimits(JSON.parse(txt));
    return snaps.length ? snaps : null;
  } catch {
    return null;
  }
}

// ── Codex probe (read the newest rollout — turn-free) ─────────────────────────

function codexHome(account: Account): string {
  const lp = account.auth.kind === "cli" ? account.auth.loginProfile : undefined;
  return lp || process.env.CODEX_HOME || join(homedir(), ".codex");
}

// Newest rollout-*.jsonl under <codexHome>/sessions, by mtime (sessions nest by
// year/month/day). Cheap: we only stat candidates, read at most a few.
function newestRollouts(sessionsDir: string, limit = 4): string[] {
  const found: { path: string; mtime: number }[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 5) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (e.startsWith("rollout-") && e.endsWith(".jsonl")) found.push({ path: p, mtime: st.mtimeMs });
    }
  };
  walk(sessionsDir, 0);
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((x) => x.path);
}

// Scan a rollout from the end for the last populated rate_limits + its timestamp.
function rateLimitsFromRollout(path: string): { rl: any; at?: number } | null {
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").split("\n");
  } catch {
    return null;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]?.trim();
    if (!t || t.indexOf("rate_limits") === -1) continue;
    let obj: any;
    try { obj = JSON.parse(t); } catch { continue; }
    const rl = findRateLimits(obj);
    if (rl) {
      const at = num(obj.timestamp) ?? parseTs(obj.timestamp) ?? parseTs(obj.ts) ?? undefined;
      return { rl, at };
    }
  }
  return null;
}

function parseTs(x: any): number | undefined {
  if (typeof x !== "string") return undefined;
  const ms = Date.parse(x);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Probe one Codex/ChatGPT subscription account by reading the newest rollout it
 *  already wrote. Turn-free; may be slightly stale (snapshots carry their real
 *  observation time so the UI shows honest "observed Xm ago"). */
export function probeCodexUsage(account: Account): ProbeSnapshot[] | null {
  if (account.auth.kind !== "cli") return null;
  const sessions = join(codexHome(account), "sessions");
  if (!existsSync(sessions)) return null;
  for (const path of newestRollouts(sessions)) {
    const hit = rateLimitsFromRollout(path);
    if (!hit) continue;
    const snaps = parseCodexRateLimits(hit.rl, hit.at ?? statMtime(path));
    if (snaps.length) return snaps;
  }
  return null;
}

function statMtime(path: string): number | undefined {
  try { return statSync(path).mtimeMs; } catch { return undefined; }
}

// ── dispatcher ────────────────────────────────────────────────────────────────

/** Probe a subscription account's real usage. Claude runs a PTY statusLine probe
 *  (needs a tiny turn); Codex reads its rollout (turn-free). Null for anything
 *  that isn't a recognized CLI subscription or on any failure. */
export async function probeUsage(account: Account): Promise<ProbeSnapshot[] | null> {
  if (account.exec !== "cli" || account.auth.kind !== "cli") return null;
  const bin = account.auth.binary;
  if (bin.includes("claude")) return probeClaudeUsage(account);
  if (bin.includes("codex")) return probeCodexUsage(account);
  return null;
}
