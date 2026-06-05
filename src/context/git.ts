import { spawnSyncProc } from "../proc.ts";

function git(args: string[], cwd: string): string {
  const r = spawnSyncProc(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : "";
}

export function gitContext(cwd = process.cwd()): string {
  if (!git(["rev-parse", "--is-inside-work-tree"], cwd)) return "";
  const branch = git(["branch", "--show-current"], cwd) || git(["rev-parse", "--short", "HEAD"], cwd);
  const status = git(["status", "--short"], cwd);
  const staged = git(["diff", "--cached", "--stat"], cwd);
  const unstaged = git(["diff", "--stat"], cwd);
  const commits = git(["log", "--oneline", "-5"], cwd);
  const parts: string[] = [];
  if (branch) parts.push(`branch: ${branch}`);
  if (status) parts.push(`dirty files:\n${status}`);
  else parts.push("working tree: clean");
  if (staged) parts.push(`staged diff stat:\n${staged}`);
  if (unstaged) parts.push(`unstaged diff stat:\n${unstaged}`);
  if (commits) parts.push(`recent commits:\n${commits}`);
  return parts.join("\n\n");
}
