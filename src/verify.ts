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

// "Done with proof" tiering (DESIGN M3): which bar a turn actually cleared, from
// the intents of the checks that PASSED. tests (ran tests, green) > types (typecheck
// / build / lint green, but no test run) > none (edited files, nothing to verify).
// Lets the summary state honestly what was proven instead of implying "done".
export type ProofTier = "tests" | "types" | "none";
export function provenTier(passedIntents: (string | undefined)[]): ProofTier {
  if (passedIntents.includes("test")) return "tests";
  if (passedIntents.some((i) => i === "typecheck" || i === "build" || i === "lint")) return "types";
  return "none";
}

/** One-line failure summary from check output: the first error-looking line, clipped. */
export function summarize(output: string): string {
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

// ── Auto-iterate-to-green ────────────────────────────────────────────────────
// When verification fails after a turn that edited files, Gearbox can feed the
// failure straight back to the model and re-run, bounded so it can't loop forever.
// `/verify off` disables this (and the verification step entirely).

export type VerifyMode = "auto" | "off";

export const MAX_AUTOFIX_ATTEMPTS = 3;

export function shouldAutoFix(input: {
  mode: VerifyMode;
  attempt: number;
  failures: string[];
  changedFiles: string[];
}): boolean {
  if (input.mode !== "auto") return false;
  if (input.failures.length === 0) return false;
  if (input.changedFiles.length === 0) return false; // not our regression to chase
  return input.attempt < MAX_AUTOFIX_ATTEMPTS;
}

export function buildFixPrompt(failures: string[]): string {
  const list = failures.map((f) => `  - ${f}`).join("\n");
  return [
    "The checks I ran after your last change did not pass:",
    "",
    list,
    "",
    "Fix the cause of these failures and make the checks pass. Only change what is",
    "needed; do not revert unrelated work.",
  ].join("\n");
}

// ── Characterization-test offer ──────────────────────────────────────────────
// When a project has NO test command (or only build/typecheck), "done with
// proof" tops out at the types tier forever. After a clean turn that changed
// code, Gearbox offers ONCE to capture the changed code's current behavior in
// a characterization test (/verify test). Accepting it makes the model add a
// real test (and a package.json test script where applicable), after which
// detection finds it and the offer never recurs structurally.

/** Does any detected check actually run tests? Covers both "no commands" and
 *  "only build/typecheck" with one predicate. */
export function hasTestCheck(cmds: VerificationCommand[]): boolean {
  return cmds.some((c) => checkIntent(c.command) === "test");
}

const CODE_FILE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/;

export function shouldOfferCharTest(input: {
  mode: VerifyMode;
  hadError: boolean;
  changedFiles: string[];
  commands: VerificationCommand[];
  alreadyOffered: boolean;
  optedOut: boolean;
}): boolean {
  if (input.mode !== "auto") return false;
  if (input.hadError) return false;
  if (input.alreadyOffered || input.optedOut) return false;
  if (hasTestCheck(input.commands)) return false;
  return input.changedFiles.some((f) => CODE_FILE_RE.test(f)); // doc-only turns never trigger it
}

export function buildCharTestPrompt(changedFiles: string[]): string {
  const list = changedFiles.map((f) => `  - ${f}`).join("\n");
  return [
    "This project has no test command. Write a CHARACTERIZATION test that captures",
    "the CURRENT behavior of the code changed this turn:",
    "",
    list,
    "",
    "Rules:",
    "- Assert what the code does NOW. Do not fix or judge behavior — if something",
    "  looks suspicious, flag it in a comment, never in an assertion.",
    "- Never assert on timestamps, randomness, or other non-deterministic output.",
    "- Follow the project's existing test layout and framework if any test files",
    "  exist; otherwise use the runtime's built-in runner (bun:test / node:test /",
    "  pytest / go test) and the conventional location (a test/ directory, or",
    "  <name>.test.<ext> beside the file).",
    "- If package.json exists without a test script, add one so future",
    "  verification picks it up.",
    "- RUN the test and confirm it passes before finishing.",
  ].join("\n");
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
