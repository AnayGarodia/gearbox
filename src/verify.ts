import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runShellStream, type ShellResult } from "./shell.ts";
import type { OnEvent } from "./agent/events.ts";

export interface VerificationCommand {
  command: string;
  reason: string;
}

function readJson(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function packageManager(cwd: string): "bun" | "pnpm" | "yarn" | "npm" {
  if (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb"))) return "bun";
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

function packageCommands(cwd: string): VerificationCommand[] {
  const pkg = readJson(join(cwd, "package.json"));
  const scripts = pkg?.scripts ?? {};
  if (!scripts || typeof scripts !== "object") return [];
  const pm = packageManager(cwd);
  const run = (name: string) => (pm === "npm" ? `npm run ${name}` : `${pm} run ${name}`);
  const cmds: VerificationCommand[] = [];
  if (scripts.typecheck) cmds.push({ command: run("typecheck"), reason: "typecheck script" });
  if (scripts.test) cmds.push({ command: pm === "npm" ? "npm test" : pm === "bun" ? "bun test" : `${pm} test`, reason: "test script" });
  if (scripts.build) cmds.push({ command: run("build"), reason: "build script" });
  return cmds;
}

export function detectVerificationCommands(cwd = process.cwd(), changedFiles: string[] = []): VerificationCommand[] {
  const cmds = packageCommands(cwd);
  const hasPython = changedFiles.some((f) => /\.py$/.test(f)) || existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "pytest.ini"));
  const hasRust = changedFiles.some((f) => /\.rs$/.test(f)) || existsSync(join(cwd, "Cargo.toml"));
  const hasGo = changedFiles.some((f) => /\.go$/.test(f)) || existsSync(join(cwd, "go.mod"));
  if (hasPython && !cmds.some((c) => /\bpytest\b/.test(c.command))) cmds.push({ command: "pytest", reason: "python project" });
  if (hasRust && !cmds.some((c) => /\bcargo\s+test\b/.test(c.command))) cmds.push({ command: "cargo test", reason: "rust project" });
  if (hasGo && !cmds.some((c) => /\bgo\s+test\b/.test(c.command))) cmds.push({ command: "go test ./...", reason: "go project" });
  return cmds.slice(0, 3);
}

// Map a verification/shell command to the named action it performs, so the UI can
// say "typecheck" instead of `cd … && bun run typecheck 2>&1 | tail -20`.
export function checkIntent(command: string): string | null {
  const c = command.toLowerCase();
  if (/\btsc\b|\btypecheck\b|type-check/.test(c)) return "typecheck";
  if (/\b(test|jest|vitest|pytest|go\s+test|cargo\s+test|mocha|ava)\b/.test(c)) return "test";
  if (/\b(eslint|ruff|clippy|lint|flake8|golangci)\b/.test(c)) return "lint";
  if (/\bbuild\b/.test(c)) return "build";
  return null;
}

function summarize(output: string): string {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const fail = lines.find((l) => /\b(error|failed|failures?|exception|panic)\b/i.test(l));
  return (fail ?? lines[0] ?? "(no output)").slice(0, 160);
}

export async function runVerification(
  commands: VerificationCommand[],
  opts: { onEvent: OnEvent; signal?: AbortSignal; timeoutMs?: number } ,
): Promise<ShellResult[]> {
  const results: ShellResult[] = [];
  for (const c of commands) {
    opts.onEvent({ type: "phase", label: "verifying", detail: `${c.command} · ${c.reason}`, state: "running" });
    const startedAt = Date.now();
    const r = await runShellStream(c.command, { signal: opts.signal, timeoutMs: opts.timeoutMs ?? 120_000 });
    results.push(r);
    opts.onEvent({ type: "verification", command: c.command, ok: r.ok, summary: r.ok ? "passed" : summarize(r.output), intent: checkIntent(c.command) ?? undefined, durationMs: Date.now() - startedAt, output: r.output });
    opts.onEvent({ type: "phase", label: "verification", detail: c.command, state: r.ok ? "ok" : "err" });
    if (!r.ok) break;
  }
  return results;
}

// What to suggest after a turn whose verification FAILED. /retry only makes sense
// when the model could plausibly fix it by regenerating — not for a conflict
// marker, and not for an error in a file the turn never touched (pre-existing).
export function nextStepFor(failures: string[], changedFiles: string[]): string {
  if (!failures.length) return changedFiles.length ? "commit changes" : "/context";
  const joined = failures.join("\n");
  // A merge-conflict marker (TS1185) can't be fixed by re-running generation.
  if (/\bTS1185\b|merge conflict|conflict marker|<<<<<<<|>>>>>>>/i.test(joined)) {
    const m = joined.match(/([\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs))[(:]/);
    return m ? `resolve the conflict in ${m[1]}` : "resolve the merge conflict";
  }
  // If every file named in the errors is one the turn DIDN'T change, the failure
  // most likely predates this turn — don't pin it on the user's change.
  const errFiles = [...joined.matchAll(/([\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs))[(:]/g)].map((x) => x[1]!);
  if (errFiles.length && errFiles.every((f) => !changedFiles.some((c) => c === f || c.endsWith(f) || f.endsWith(c)))) {
    return "likely predates your change — check the repo state";
  }
  return "/retry";
}
