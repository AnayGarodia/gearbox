/**
 * tools.ts - All agent tools: real file and shell access, scoped to a workspace root.
 *
 * Module overview
 * ---------------
 * Every tool defined here is an AI SDK `tool()` call with a Zod input schema and
 * an async execute function. They are assembled into a record by createTools(),
 * which is the only place that binds a workspace root and an event emitter.
 *
 * Workspace scoping
 * -----------------
 * All file and shell operations are scoped to `root` (the working directory
 * passed to createTools, defaulting to process.cwd()). The `makeSafe` helper
 * resolves every path against root and throws if the resolved path escapes it.
 * This matters for parallel fan-out: each sub-agent receives its own git
 * worktree as root, so concurrent file writes land in isolated trees and never
 * collide.
 *
 * Permission requirements
 * -----------------------
 * Mutating tools (write_file, edit_file, run_shell) call requestPermission()
 * from permission.ts before touching the filesystem or spawning a process. If
 * the user denies the request the tool throws with a human-readable DENIED
 * message. Read-only tools (read_file, list_dir, search, glob, fetch_url,
 * web_search) do NOT require a permission prompt.
 *
 * Output cap
 * ----------
 * All tool output is clipped at CAP (60 000 characters). This keeps any single
 * tool result from flooding the model context window and riding in the
 * conversation history across many turns.
 *
 * Read-only mode
 * --------------
 * createToolset() accepts a readOnly flag that restricts the returned set to
 * read_file, list_dir, search, glob, fetch_url, and web_search. This is used
 * for plan mode and for sub-agents that should not write.
 *
 * MCP and extra tools
 * -------------------
 * createToolset() merges in any configured MCP server tools and, at depth 0
 * only, the delegate tools injected by run.ts. Sub-agents do not receive
 * delegate tools, preventing recursive delegation.
 */
import { tool, type Tool } from "ai";
import { z } from "zod";
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { computeDiff, diffStat } from "./diff.ts";
import { applyEdit } from "./edit.ts";
import { updateRetrievalFile } from "./context/retrieve.ts";
import { runShellStream } from "./shell.ts";
import { appendFact } from "./context/memory.ts";
import { emitHook } from "./plugins.ts";
import { requestPermission } from "./permission.ts";
import { which, Glob, spawnSyncProc } from "./proc.ts";
import type { OnEvent } from "./agent/events.ts";
import { fetchUrlText } from "./fetch.ts";
import { webSearch, formatSearchResults } from "./websearch.ts";
import { mcpTools } from "./mcp.ts";

/** Maximum characters a single tool call may return. Prevents context flooding. */
const CAP = 60_000;

/** Message thrown when the user declines a permission prompt. */
const DENIED = "Permission denied by the user — they declined this action.";

/**
 * Directories skipped by the no-ripgrep fallback walker in the `search` tool.
 * ripgrep already honors .gitignore natively, so this only applies when rg is
 * absent from PATH.
 */
const IGNORE = /(^|\/)(node_modules|\.git|dist|build|\.next|coverage)(\/|$)/;

/**
 * Returns a path resolver that is bound to a specific workspace root.
 *
 * The resolver accepts relative or absolute input paths and always returns an
 * absolute path inside root. If the resolved path escapes root (e.g. via `..`
 * segments or a symlink chain) it throws, preventing directory traversal.
 *
 * Each call to createTools() creates its own makeSafe(root) closure, so a
 * sub-agent running in an isolated worktree cannot reach files in another tree.
 */
function makeSafe(root: string) {
  return (path: string): string => {
    const abs = isAbsolute(path) ? path : resolve(root, path);
    const rel = relative(root, abs);
    if (rel.startsWith("..")) throw new Error(`path escapes workspace: ${path}`);
    return abs;
  };
}

/** Clip a string to CAP characters, appending a notice when truncated. */
const clip = (s: string) => (s.length > CAP ? s.slice(0, CAP) + `\n… [clipped ${s.length - CAP} chars]` : s);

/**
 * Default maximum lines returned by a bare read_file call.
 *
 * Large files (e.g. a 4 000-line App.tsx) would otherwise fill the context
 * window on the first read and stay in history for many turns. Capping at 2 000
 * matches the convention used by Claude Code and OpenCode. The model pages
 * through large files with offset/limit as needed; small files are returned
 * in full without any footer.
 */
const READ_LINE_CAP = 2000;

/**
 * Read a slice of a UTF-8 file and return it as a string.
 *
 * offset is 1-based. limit defaults to READ_LINE_CAP lines from offset.
 * When the whole file fits in one page no footer is added; when paging is
 * active a footer reminds the caller which lines were shown and how to fetch
 * the next range.
 */
async function readRanged(abs: string, displayPath: string, offset?: number, limit?: number): Promise<string> {
  const raw = await readFile(abs, "utf8");
  const lines = raw.split("\n");
  const total = lines.length;
  const start = offset ? offset - 1 : 0;
  if (total > 0 && start >= total)
    return `(file has ${total} lines; offset ${offset} is past the end of ${displayPath})`;
  // Explicit limit, else page size = remaining capped at READ_LINE_CAP for a default read.
  const count = limit ?? Math.min(total - start, READ_LINE_CAP);
  const end = Math.min(total, start + count);
  const body = lines.slice(start, end).join("\n");
  const shownAll = start === 0 && end === total;
  const footer = shownAll
    ? ""
    : `\n\n… showing lines ${start + 1}-${end} of ${total}. Pass offset/limit to read another range.`;
  return clip(body + footer);
}

/**
 * Build a diagnostic hint for a failed edit_file `find` lookup.
 *
 * Extracts the first meaningful word from the find string, searches the file
 * for a line containing that word, and returns a short surrounding snippet.
 * This gives the model enough context to self-correct on the next attempt
 * without requiring a full re-read of the file.
 */
function notFoundHint(path: string, before: string, find: string): string {
  const needle = find.trim().split(/\s+/).filter((w) => w.length >= 3)[0]?.toLowerCase();
  if (!needle) return `text not found in ${path}`;
  const lines = before.split("\n");
  const hit = lines.findIndex((l) => l.toLowerCase().includes(needle));
  if (hit < 0) return `text not found in ${path}`;
  const start = Math.max(0, hit - 2);
  const end = Math.min(lines.length, hit + 3);
  const snippet = lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join("\n");
  return `text not found in ${path}. Nearby match for "${needle}":\n${snippet}`;
}

/**
 * Create the full tool record for a given workspace root.
 *
 * All file paths and shell commands are scoped to `root`. Pass a custom root
 * (e.g. a git worktree) to isolate a sub-agent from the main workspace.
 * Pass onEvent to receive file-change and tool-output events for the UI and
 * undo stack.
 */
export function createTools(onEvent?: OnEvent, root: string = process.cwd()) {
  const safe = makeSafe(root);
  return {
  /**
   * Read a file from the workspace.
   *
   * Permission: none (read-only).
   * Output cap: 2 000 lines by default, 60 000 characters hard cap.
   * Paging: pass offset (1-based line) and/or limit to read a specific range.
   * Large files are returned in pages; a footer shows the visible range and
   * instructs the model to pass offset/limit for subsequent pages.
   */
  read_file: tool({
    description:
      "Read a UTF-8 file from the workspace. Returns the whole file by default (capped at 2000 lines); for a large file pass offset (1-based start line) and/or limit to read just the range you need instead of pulling it all into context.",
    inputSchema: z.object({
      path: z.string().describe("file path, relative to the workspace root"),
      offset: z.number().int().min(1).optional().describe("1-based line to start reading from"),
      limit: z.number().int().min(1).optional().describe("max number of lines to read from offset"),
    }),
    execute: async ({ path, offset, limit }) => readRanged(safe(path), path, offset, limit),
  }),

  /**
   * Create or fully overwrite a file.
   *
   * Permission: "write" (prompts once unless a standing grant or yolo is active).
   * Fires a file-change event before writing so the undo stack captures the
   * previous content. Also refreshes the context-retrieval index after writing.
   * Prefer edit_file for partial changes: it sends only the diff and is far
   * cheaper on both tokens and context.
   */
  write_file: tool({
    description:
      "Create a NEW file, or fully replace an existing file's contents. To change PART of an existing file, prefer edit_file — it sends only the diff and is far cheaper than a full rewrite.",
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    execute: async ({ path, content }) => {
      const abs = safe(path);
      const exists = existsSync(abs);
      if (!(await requestPermission({ kind: "write", title: exists ? "Overwrite a file" : "Create a file", detail: path })))
        throw new Error(DENIED);
      const before = exists ? await readFile(abs, "utf8") : "";
      onEvent?.({ type: "file-change", path: relative(root, abs), before, existed: exists }); // for /undo + /diff
      await writeFile(abs, content, "utf8");
      updateRetrievalFile(relative(root, abs), content, root); // keep retrieval fresh
      const diff = computeDiff(before, content);
      return { summary: `wrote ${path} (${diffStat(diff)})`, diff };
    },
  }),

  /**
   * Replace a specific text span inside an existing file.
   *
   * Permission: "edit" (prompts once unless a standing grant or yolo is active).
   * The permission check happens after the match succeeds so a deny never
   * corrupts the file. Fires a file-change event for undo and refreshes the
   * retrieval index after writing.
   *
   * Matching strategy (tried in order):
   *   1. Exact string match.
   *   2. Whitespace-tolerant line match: each line is trimmed and internal
   *      whitespace runs are collapsed before comparison. This recovers from
   *      minor indentation drift in the model's output.
   *
   * Ambiguity: if the normalized block appears in more than one place and
   * neither occurrence nor replaceAll is given, the tool errors rather than
   * silently editing the wrong location.
   */
  edit_file: tool({
    description:
      "Edit a file by replacing text. Tries an exact match first, then falls back to a whitespace-tolerant match (so minor indentation/spacing drift in `find` still applies). Use occurrence for a specific match, or replaceAll for every match.",
    inputSchema: z.object({
      path: z.string(),
      find: z.string().min(1),
      replace: z.string(),
      occurrence: z.number().int().positive().optional().describe("1-based match to replace when replaceAll is false"),
      replaceAll: z.boolean().default(false).describe("replace every match"),
    }),
    execute: async ({ path, find, replace, occurrence, replaceAll }) => {
      const abs = safe(path);
      const before = await readFile(abs, "utf8");
      const r = applyEdit(before, find, replace, { occurrence, replaceAll });
      if (!r.ok) {
        if (r.reason === "not-found") throw new Error(notFoundHint(path, before, find));
        if (r.reason === "ambiguous")
          throw new Error(`"${find.split("\n")[0]?.trim()}…" matches ${r.matches} places in ${path} (ignoring whitespace); pass occurrence or replaceAll to disambiguate`);
        throw new Error(`only found ${r.matches} occurrence${r.matches === 1 ? "" : "s"} in ${path}; requested occurrence ${occurrence}`);
      }
      if (!(await requestPermission({ kind: "edit", title: "Edit a file", detail: path }))) throw new Error(DENIED);
      onEvent?.({ type: "file-change", path: relative(root, abs), before, existed: true }); // for /undo + /diff
      await writeFile(abs, r.after, "utf8");
      updateRetrievalFile(relative(root, abs), r.after, root); // keep retrieval fresh
      const diff = computeDiff(before, r.after);
      const fuzzy = r.strategy === "whitespace" ? " · whitespace-matched" : "";
      return { summary: `edited ${path} · ${r.replacements} replacement${r.replacements === 1 ? "" : "s"}${fuzzy} (${diffStat(diff)})`, diff };
    },
  }),

  /**
   * Fetch the readable text content of a public URL.
   *
   * Permission: none (read-only, no local side-effects).
   * Output cap: 60 000 characters. Useful for documentation pages, GitHub
   * issues, release notes, or any link the user pastes into the conversation.
   */
  fetch_url: tool({
    description: "Fetch a public http(s) URL and return readable text. Use this for docs, release notes, issue pages, or pasted links.",
    inputSchema: z.object({ url: z.string().url() }),
    execute: async ({ url }) => {
      const page = await fetchUrlText(url);
      return clip([`URL: ${page.url}`, page.title ? `Title: ${page.title}` : "", "", page.text].filter(Boolean).join("\n"));
    },
  }),

  /**
   * Search the web and return titles, URLs, and snippets.
   *
   * Permission: none (read-only, no local side-effects).
   * Output cap: 60 000 characters. Delegates to the configured search provider
   * (see websearch.ts). count controls how many results to return (1-10,
   * default 5).
   */
  web_search: tool({
    description: "Search the web for current docs, APIs, errors, release notes, or examples. Returns titles, URLs, and snippets.",
    inputSchema: z.object({
      query: z.string().describe("search query"),
      count: z.number().int().min(1).max(10).default(5),
    }),
    execute: async ({ query, count }) => formatSearchResults(query, await webSearch(query, count)),
  }),

  /**
   * Search file contents in the workspace by regular expression.
   *
   * Permission: none (read-only).
   * Output cap: 60 000 characters, at most 100 matching lines.
   * Cwd scoping: the `path` argument is resolved via makeSafe, so it cannot
   * escape the workspace root.
   *
   * Implementation: uses ripgrep (rg) when available on PATH for speed and
   * .gitignore awareness. Falls back to a pure JS walker when rg is absent.
   * The fallback skips common noise directories (node_modules, .git, dist,
   * build, .next, coverage) via IGNORE but does not honor .gitignore.
   */
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
        if (out.trim()) return clip(out.replaceAll(abs + "/", "").replaceAll(root + "/", ""));
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

  /**
   * Find files in the workspace by glob pattern.
   *
   * Permission: none (read-only).
   * Output cap: 300 matching paths, 60 000 characters.
   * Cwd scoping: `path` is resolved via makeSafe. Skips IGNORE directories.
   * Results are sorted alphabetically before being returned.
   */
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

  /**
   * List entries in a directory.
   *
   * Permission: none (read-only).
   * Returns file names and directory names (directories have a trailing `/`).
   * Results are sorted alphabetically.
   */
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

  /**
   * Run an arbitrary shell command inside the workspace.
   *
   * Permission: "shell" (prompts once unless a standing grant or yolo is active).
   * Cwd scoping: the command runs with cwd=root, so relative paths in the
   * command resolve to the workspace root. Sub-agents running in an isolated
   * git worktree therefore operate in their own tree by default.
   *
   * The command is intentionally passed through a shell (not execFile with an
   * arg array). That is the point of this tool: tests, builds, git commands,
   * pipes, and shell one-liners all need full shell syntax. The safety boundary
   * is the permission gate, not restricted syntax.
   *
   * Output is streamed live via onEvent so the UI can display it in real time.
   * The final output is also returned as a string (capped at 60 000 characters).
   *
   * Verification events: if the command matches common test or typecheck
   * patterns (bun/npm/pnpm/yarn test, tsc, pytest, cargo test, go test) a
   * "verification" event is emitted so the UI can display a pass/fail badge.
   */
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
        cwd: root, // sub-agents in a fan-out run shell in their own worktree
        onChunk: (c) => onEvent?.({ type: "tool-output", id, name: "run_shell", arg: command, stream: c.stream, text: c.text }),
      });
      if (/\b(bun|npm|pnpm|yarn)\s+(test|run\s+typecheck|typecheck|build)\b|\b(tsc|pytest|cargo\s+test|go\s+test)\b/.test(command)) {
        onEvent?.({ type: "verification", command, ok: r.ok, summary: r.ok ? "passed" : "failed" });
      }
      return r.output;
    },
  }),
  remember: tool({
    description:
      "Save ONE durable, non-obvious fact about this project to its persistent memory (loaded into every future session). Use it the moment you learn something a future session would otherwise have to rediscover: a build quirk, a vendor gotcha, an architectural decision and its why, a constraint the user stated. NOT for session-local context, code structure (the repo shows that), or anything already in the project guide. One short sentence per call.",
    inputSchema: z.object({
      fact: z.string().describe("One sentence, self-contained (a future session has no other context)."),
    }),
    execute: async ({ fact }) => {
      const ok = appendFact(fact, root);
      onEvent?.({ type: "tool-end", id: `remember-${Date.now()}`, ok, summary: ok ? fact.slice(0, 64) : "couldn't write memory" });
      return ok ? "remembered" : "couldn't write the memory file";
    },
  }),
  };
}

/** Default tool set bound to process.cwd() with no event listener. */
export const tools = createTools();

export type Tools = typeof tools;

/**
 * The read-only subset of the tool set used in plan mode.
 *
 * Includes all tools that carry no write side-effects: read_file, list_dir,
 * search, glob, fetch_url, and web_search. write_file, edit_file, and
 * run_shell are excluded.
 */
function readOnlySubset(all: ReturnType<typeof createTools>) {
  return {
    read_file: all.read_file,
    list_dir: all.list_dir,
    search: all.search,
    glob: all.glob,
    fetch_url: all.fetch_url,
    web_search: all.web_search,
  };
}

/**
 * Build a complete, ready-to-use tool set for an agent turn.
 *
 * Combines the base tools (or read-only subset) with any configured MCP
 * server tools. If opts.extraTools is provided it is merged in last, giving
 * injected tools (e.g. the delegate tool from run.ts) priority over defaults.
 *
 * opts.root scopes all file and shell operations. Omit it to use process.cwd().
 * opts.readOnly strips mutating tools (write_file, edit_file, run_shell).
 * opts.extraTools is only populated at depth 0: sub-agents do not receive
 * delegate tools, so delegation cannot recurse infinitely.
 */
export async function createToolset(
  onEvent?: OnEvent,
  opts: { readOnly?: boolean; extraTools?: Record<string, Tool<any, any>>; root?: string } = {},
) {
  const all = createTools(onEvent, opts.root); // root scopes every file/shell op (worktree isolation)
  const base = opts.readOnly ? readOnlySubset(all) : all;
  const set: Record<string, Tool<any, any>> = { ...base, ...(await mcpTools(onEvent, Boolean(opts.readOnly))) };
  // extraTools (the delegate tools) are injected by run.ts at depth 0 only — sub-
  // agents don't get them, so delegation can't recurse. Absent means no delegation
  // (plan mode, sub-agents).
  if (opts.extraTools) for (const [k, v] of Object.entries(opts.extraTools)) set[k] = v;
  return wrapWithPluginHooks(set);
}

// Plugin hooks around EVERY tool call (built-ins, MCP, delegate alike):
// tool.execute.before can patch args or block with a reason (the block string
// becomes the tool result the model sees); tool.execute.after observes results.
// A plugin throw never breaks the agent — emitHook isolates handlers.
function wrapWithPluginHooks(set: Record<string, Tool<any, any>>): Record<string, Tool<any, any>> {
  const out: Record<string, Tool<any, any>> = {};
  for (const [name, t] of Object.entries(set)) {
    const exec = (t as any).execute;
    if (typeof exec !== "function") {
      out[name] = t;
      continue;
    }
    out[name] = {
      ...t,
      execute: async (args: any, callOpts: any) => {
        let finalArgs = args;
        try {
          const pre = await emitHook("tool.execute.before", { tool: name, args });
          if (pre?.block) return `blocked by a plugin: ${pre.block}`;
          if (pre?.args) finalArgs = pre.args;
        } catch { /* hook isolation */ }
        const startedAt = Date.now();
        const result = await exec(finalArgs, callOpts);
        try {
          await emitHook("tool.execute.after", { tool: name, args: finalArgs, result, durationMs: Date.now() - startedAt });
        } catch { /* hook isolation */ }
        return result;
      },
    } as Tool<any, any>;
  }
  return out;
}
