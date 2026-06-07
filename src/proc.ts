// Node.js compatibility shim for Bun process APIs.
// Presents a Bun-flavoured interface over Node child_process so every caller
// works under both runtimes without runtime checks scattered everywhere.
import { spawn, spawnSync as nodeSpawnSync, execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// ── which ─────────────────────────────────────────────────────────────────
export function which(bin: string): string | null {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(cmd, [bin], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim().split("\n")[0]?.trim() || null;
  } catch {
    return null;
  }
}

// ── Glob ──────────────────────────────────────────────────────────────────
// Simple recursive walker + minimatch-free pattern check.
// Handles the two patterns actually used: "**/*" (all files) and arbitrary
// glob strings (forwarded to a basic match that covers *.ext and **/ paths).
export class Glob {
  constructor(private pattern: string) {}

  *scanSync(opts: { cwd: string; onlyFiles?: boolean }): Generator<string> {
    yield* walkSync(opts.cwd, this.pattern, opts.onlyFiles ?? true);
  }
}

const GLOB_IGNORE = /(^|\/)(node_modules|\.git|dist|build|\.next|coverage)(\/|$)/;

function globMatch(pattern: string, relPath: string): boolean {
  if (pattern === "**/*" || pattern === "**") return true;
  // Convert to regex: ** → .+, * → [^/]+, . → \.
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, ".+")
        .replace(/\*/g, "[^/]+") +
      "$",
  );
  return re.test(relPath);
}

function walkSync(dir: string, pattern: string, onlyFiles: boolean, rel = ""): string[] {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const e of entries) {
    const relPath = rel ? `${rel}/${e}` : e;
    if (GLOB_IGNORE.test(relPath)) continue;
    const abs = resolve(dir, e);
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      results.push(...walkSync(abs, pattern, onlyFiles, relPath));
    } else if (!onlyFiles || !isDir) {
      if (globMatch(pattern, relPath)) results.push(relPath);
    }
  }
  return results;
}

// ── read a Node Readable stream to a string ───────────────────────────────
export async function readStream(s: NodeJS.ReadableStream | null | undefined): Promise<string> {
  if (!s) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of s) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ── spawn (streaming, async) ──────────────────────────────────────────────
export interface Proc {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  stdin: { write(d: string | Uint8Array): void; end(): void } | null;
  exited: Promise<number | null>;
  readonly exitCode: number | null;
  kill(signal?: NodeJS.Signals | number): void;
}

type PipeSpec = "pipe" | "ignore" | "inherit";

interface SpawnProcOpts {
  cwd?: string;
  stdin?: PipeSpec;
  stdout?: PipeSpec;
  stderr?: PipeSpec;
  env?: NodeJS.ProcessEnv;
}

export function spawnProc(cmd: string[], opts: SpawnProcOpts = {}): Proc {
  const child: ChildProcess = spawn(cmd[0]!, cmd.slice(1), {
    cwd: opts.cwd ?? process.cwd(),
    stdio: [opts.stdin ?? "ignore", opts.stdout ?? "pipe", opts.stderr ?? "pipe"],
    env: opts.env ?? process.env,
  });
  const exited = new Promise<number | null>((res) => {
    child.on("close", (code) => res(code));
    child.on("error", () => res(null));
  });
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    stdin: child.stdin
      ? {
          write: (d) => child.stdin!.write(d),
          end: () => child.stdin!.end(),
        }
      : null,
    exited,
    get exitCode() {
      return child.exitCode;
    },
    kill: (signal?: NodeJS.Signals | number) => { try { child.kill(signal); } catch { /* already dead */ } },
  };
}

// ── spawnSync ─────────────────────────────────────────────────────────────
export interface SpawnSyncResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
}

interface SpawnSyncOpts {
  cwd?: string;
  stdin?: PipeSpec;
  stdout?: PipeSpec;
  stderr?: PipeSpec;
  env?: NodeJS.ProcessEnv;
}

export function spawnSyncProc(cmd: string[], opts: SpawnSyncOpts = {}): SpawnSyncResult {
  const r = nodeSpawnSync(cmd[0]!, cmd.slice(1), {
    cwd: opts.cwd ?? process.cwd(),
    stdio: [opts.stdin ?? "ignore", opts.stdout ?? "pipe", opts.stderr ?? "pipe"],
    env: opts.env ?? process.env,
  });
  return {
    stdout: (r.stdout as Buffer | null) ?? Buffer.alloc(0),
    stderr: (r.stderr as Buffer | null) ?? Buffer.alloc(0),
    exitCode: r.status,
  };
}

// ── write file (matches Bun.write signature subset) ───────────────────────
export { writeFile as write };
