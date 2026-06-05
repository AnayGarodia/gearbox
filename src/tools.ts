// The harness's tools. Real file + shell access, scoped to the working dir.
// v0.1 keeps them simple; permission prompts / sandboxing get richer later.
import { tool } from "ai";
import { z } from "zod";
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { computeDiff, diffStat } from "./diff.ts";
import { runShellStream } from "./shell.ts";
import { requestPermission } from "./permission.ts";
import { which, Glob, spawnSyncProc } from "./proc.ts";
import type { OnEvent } from "./agent/events.ts";

const ROOT = process.cwd();
const CAP = 60_000; // cap tool output so the transcript stays sane

const DENIED = "Permission denied by the user — they declined this action.";

// Common dirs to skip in the no-ripgrep fallback (ripgrep already honors .gitignore).
const IGNORE = /(^|\/)(node_modules|\.git|dist|build|\.next|coverage)(\/|$)/;

/** Resolve a path and refuse to escape the workspace root. */
function safe(path: string): string {
  const abs = isAbsolute(path) ? path : resolve(ROOT, path);
  const rel = relative(ROOT, abs);
  if (rel.startsWith("..")) throw new Error(`path escapes workspace: ${path}`);
  return abs;
}

const clip = (s: string) => (s.length > CAP ? s.slice(0, CAP) + `\n… [clipped ${s.length - CAP} chars]` : s);

export function createTools(onEvent?: OnEvent) {
  return {
  read_file: tool({
    description: "Read a UTF-8 file from the workspace.",
    inputSchema: z.object({ path: z.string().describe("file path, relative to the workspace root") }),
    execute: async ({ path }) => clip(await readFile(safe(path), "utf8")),
  }),

  write_file: tool({
    description: "Create or overwrite a file with the given contents.",
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    execute: async ({ path, content }) => {
      const abs = safe(path);
      const exists = existsSync(abs);
      if (!(await requestPermission({ kind: "write", title: exists ? "Overwrite a file" : "Create a file", detail: path })))
        throw new Error(DENIED);
      const before = exists ? await readFile(abs, "utf8") : "";
      await writeFile(abs, content, "utf8");
      const diff = computeDiff(before, content);
      return { summary: `wrote ${path} (${diffStat(diff)})`, diff };
    },
  }),

  edit_file: tool({
    description: "Replace the first exact occurrence of `find` with `replace` in a file.",
    inputSchema: z.object({ path: z.string(), find: z.string(), replace: z.string() }),
    execute: async ({ path, find, replace }) => {
      const abs = safe(path);
      const before = await readFile(abs, "utf8");
      if (!before.includes(find)) throw new Error(`text not found in ${path}`);
      if (!(await requestPermission({ kind: "edit", title: "Edit a file", detail: path }))) throw new Error(DENIED);
      const after = before.replace(find, replace);
      await writeFile(abs, after, "utf8");
      const diff = computeDiff(before, after);
      return { summary: `edited ${path} (${diffStat(diff)})`, diff };
    },
  }),

  search: tool({
    description: "Search file CONTENTS in the workspace by regex (ripgrep). Returns file:line:match. Use this to find code.",
    inputSchema: z.object({
      query: z.string().describe("a regular expression to search for"),
      path: z.string().default(".").describe("dir or file to search, relative to the workspace root"),
    }),
    execute: async ({ query, path }) => {
      const abs = safe(path);
      const rg = which("rg");
      if (rg) {
        const p = spawnSyncProc(
          [rg, "--line-number", "--no-heading", "--color", "never", "--max-columns", "240", "--max-count", "100", "-e", query, abs],
          { stdout: "pipe", stderr: "pipe" },
        );
        const out = p.stdout.toString();
        if (out.trim()) return clip(out.replaceAll(abs + "/", "").replaceAll(ROOT + "/", ""));
        return p.exitCode === 1 ? "no matches" : p.stderr.toString().trim() || "no matches";
      }
      // Fallback: walk + match (best-effort; ripgrep is far better).
      let re: RegExp;
      try {
        re = new RegExp(query);
      } catch (e: any) {
        return `invalid regex: ${e?.message ?? e}`;
      }
      const hits: string[] = [];
      for (const f of new Glob("**/*").scanSync({ cwd: abs, onlyFiles: true })) {
        if (IGNORE.test(f)) continue;
        if (hits.length >= 100) break;
        try {
          const txt = await readFile(resolve(abs, f), "utf8");
          const lines = txt.split("\n");
          for (let i = 0; i < lines.length && hits.length < 100; i++) {
            if (re.test(lines[i]!)) hits.push(`${f}:${i + 1}:${lines[i]!.slice(0, 240)}`);
          }
        } catch {
          /* skip binaries / unreadable */
        }
      }
      return hits.length ? clip(hits.join("\n")) : "no matches";
    },
  }),

  glob: tool({
    description: "Find FILES by glob pattern (e.g. 'src/**/*.ts'). Returns matching paths. Use this to locate files.",
    inputSchema: z.object({
      pattern: z.string().describe("a glob pattern, e.g. **/*.test.ts"),
      path: z.string().default(".").describe("base dir, relative to the workspace root"),
    }),
    execute: async ({ pattern, path }) => {
      const abs = safe(path);
      const matches: string[] = [];
      for (const m of new Glob(pattern).scanSync({ cwd: abs, onlyFiles: true })) {
        if (IGNORE.test(m)) continue;
        matches.push(m);
        if (matches.length >= 300) break;
      }
      return matches.length ? clip(matches.sort().join("\n")) : "no files match";
    },
  }),

  list_dir: tool({
    description: "List entries in a directory (defaults to the workspace root).",
    inputSchema: z.object({ path: z.string().default(".") }),
    execute: async ({ path }) => {
      const abs = safe(path);
      const entries = await readdir(abs);
      const rows = await Promise.all(
        entries.map(async (e) => {
          try {
            const s = await stat(resolve(abs, e));
            return s.isDirectory() ? `${e}/` : e;
          } catch {
            return e;
          }
        }),
      );
      return rows.sort().join("\n");
    },
  }),

  run_shell: tool({
    // NOTE: this intentionally runs an arbitrary command through a shell — that
    // is the whole point of a coding agent's shell tool (tests, git, pipes,
    // builds), same as Claude Code's Bash tool. `execFile` with an arg array
    // would break that. The correct safety mechanism is a permission/confirmation
    // gate before execution (planned; see DESIGN.md "safe-by-default"), NOT
    // avoiding the shell. v0.1 has no gate yet — known gap, tracked.
    description: "Run a shell command in the workspace and return its output. Use for tests, builds, git.",
    inputSchema: z.object({ command: z.string() }),
    execute: async ({ command }) => {
      if (!(await requestPermission({ kind: "shell", title: "Run a shell command", detail: command }))) throw new Error(DENIED);
      const id = `run_shell:${command}`;
      const r = await runShellStream(command, {
        onChunk: (c) => onEvent?.({ type: "tool-output", id, name: "run_shell", arg: command, stream: c.stream, text: c.text }),
      });
      if (/\b(bun|npm|pnpm|yarn)\s+(test|run\s+typecheck|typecheck|build)\b|\b(tsc|pytest|cargo\s+test|go\s+test)\b/.test(command)) {
        onEvent?.({ type: "verification", command, ok: r.ok, summary: r.ok ? "passed" : "failed" });
      }
      return r.output;
    },
  }),
  };
}

export const tools = createTools();

export type Tools = typeof tools;

// Read-only subset used in plan mode (reads + search, no writes/edits/shell).
export const readOnlyTools = {
  read_file: tools.read_file,
  list_dir: tools.list_dir,
  search: tools.search,
  glob: tools.glob,
};
