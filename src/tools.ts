// The harness's tools. Real file + shell access, scoped to the working dir.
// v0.1 keeps them simple; permission prompts / sandboxing get richer later.
import { tool } from "ai";
import { z } from "zod";
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { computeDiff, diffStat } from "./diff.ts";
import { runShell } from "./shell.ts";

const ROOT = process.cwd();
const CAP = 60_000; // cap tool output so the transcript stays sane

/** Resolve a path and refuse to escape the workspace root. */
function safe(path: string): string {
  const abs = isAbsolute(path) ? path : resolve(ROOT, path);
  const rel = relative(ROOT, abs);
  if (rel.startsWith("..")) throw new Error(`path escapes workspace: ${path}`);
  return abs;
}

const clip = (s: string) => (s.length > CAP ? s.slice(0, CAP) + `\n… [clipped ${s.length - CAP} chars]` : s);

export const tools = {
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
      const before = existsSync(abs) ? await readFile(abs, "utf8") : "";
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
      const after = before.replace(find, replace);
      await writeFile(abs, after, "utf8");
      const diff = computeDiff(before, after);
      return { summary: `edited ${path} (${diffStat(diff)})`, diff };
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
    execute: async ({ command }) => runShell(command).output,
  }),
};

export type Tools = typeof tools;

// Read-only subset used in plan mode (no writes, edits, or shell).
export const readOnlyTools = {
  read_file: tools.read_file,
  list_dir: tools.list_dir,
};
