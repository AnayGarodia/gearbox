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
    const r = await runShellStream(c.command, { signal: opts.signal, timeoutMs: opts.timeoutMs ?? 120_000 });
    results.push(r);
    opts.onEvent({ type: "verification", command: c.command, ok: r.ok, summary: r.ok ? "passed" : summarize(r.output) });
    opts.onEvent({ type: "phase", label: "verification", detail: c.command, state: r.ok ? "ok" : "err" });
    if (!r.ok) break;
  }
  return results;
}
