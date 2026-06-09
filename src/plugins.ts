/**
 * Plugin / hook system (the public contract).
 *
 * Plugins are plain TS/JS modules discovered at two locations:
 *
 *   <project>/.gearbox/plugins/*.ts     (project-local)
 *   ~/.gearbox/plugins/*.ts             (global; GEARBOX_HOME overrides ~/.gearbox)
 *
 * Accepted extensions: .ts .tsx .js .mjs .cjs — files whose name starts with
 * "_" are skipped (use them for shared helpers). TypeScript imports natively
 * under Bun. Load order is deterministic: global plugins first, then project
 * plugins (so project-local plugins run last and win merges); within each
 * directory, files load in alphabetical order.
 *
 * Each plugin default-exports a factory:
 *
 *   export default (ctx: PluginContext) => HookMap | void | Promise<HookMap | void>
 *
 * PluginContext:
 *   - projectDir  absolute path of the project the plugin was loaded for
 *   - log(msg)    surfaces a message to the host UI (a notice). Routed through
 *                 the function installed via installPluginLogger(); no-op until
 *                 the host installs one.
 *
 * HookMap — every key optional, every handler may be sync or async:
 *
 *   "tool.execute.before": ({ tool, args }) => void | { args?: any; block?: string }
 *       Runs before a tool call. Return { block: "reason" } to abort the call —
 *       the string becomes the tool error. Return { args: {...} } to patch the
 *       tool args: patches shallow-merge over the current args in load order
 *       (later plugins win key conflicts) and each subsequent handler sees the
 *       already-patched args. Any block wins (the first block string is kept);
 *       remaining handlers still run.
 *   "tool.execute.after": ({ tool, args, result, durationMs }) => void
 *       Runs after a tool call completes (observe-only).
 *   "file.edited": ({ path }) => void
 *       A file was written or edited by the agent.
 *   "session.start": ({ sessionId }) => void
 *       A session began (new or resumed).
 *   "turn.end": ({ changedFiles, hadError }) => void
 *       An agent turn finished.
 *   "permission.ask": ({ kind, title, detail }) => void | { decision?: "allow" | "deny" }
 *       Lets a plugin auto-resolve a permission prompt. Merge rule: any "deny"
 *       wins over any "allow"; no decision leaves the prompt to the user.
 *
 * Host API:
 *   - loadPlugins(projectDir?)   scan both directories, import each file, call
 *       its factory, and REPLACE the registry. A broken plugin (syntax error,
 *       missing/non-function default export, throwing factory) never crashes
 *       the app — it is collected in `errors` and the rest still load. Imports
 *       use file:// URLs with a cache-busting query so a re-load picks up
 *       changed files where the runtime honors it (Node does; Bun currently
 *       caches by path — re-running loadPlugins still re-scans for added or
 *       removed files and never duplicates handlers).
 *   - emitHook(name, payload)    run every registered handler for `name` in
 *       load order. A throwing handler is logged and skipped — it never breaks
 *       the agent. Resolves to the merged HookResult (see the per-hook merge
 *       rules above); for hooks with no return contract the result is empty.
 *   - clearPlugins()             reset the registry (tests / teardown).
 *   - installPluginLogger(fn)    receive ctx.log messages and hook-error
 *       notices (each prefixed with the plugin file's basename).
 *
 * This module is UI-free by design: the host wires loadPlugins/emitHook into
 * the agent loop and routes the logger into its notice stream.
 */

import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------- types

/** Payload carried by each hook, keyed by hook name. */
export interface HookPayloads {
  "tool.execute.before": { tool: string; args: any };
  "tool.execute.after": { tool: string; args: any; result: any; durationMs: number };
  "file.edited": { path: string };
  "session.start": { sessionId: string };
  "turn.end": { changedFiles: string[]; hadError: boolean };
  "permission.ask": { kind: string; title: string; detail?: string };
}

export type HookName = keyof HookPayloads;

export type PermissionDecision = "allow" | "deny";

/** What each hook's handler may return (void everywhere a hook is observe-only). */
interface HookReturns {
  "tool.execute.before": void | { args?: any; block?: string };
  "tool.execute.after": void;
  "file.edited": void;
  "session.start": void;
  "turn.end": void;
  "permission.ask": void | { decision?: PermissionDecision };
}

/** The hooks a plugin registers. All optional; all may be async. */
export type HookMap = {
  [K in HookName]?: (payload: HookPayloads[K]) => HookReturns[K] | Promise<HookReturns[K]>;
};

export interface PluginContext {
  /** Absolute path of the project the plugins were loaded for. */
  projectDir: string;
  /** Surface a message to the host UI (lands as a notice). */
  log: (msg: string) => void;
}

/** The shape of a plugin module's default export. */
export type Plugin = (ctx: PluginContext) => Promise<HookMap | void> | HookMap | void;

/**
 * Merged outcome of emitHook. Only the fields relevant to the emitted hook are
 * ever set:
 *  - args      (tool.execute.before) the COMPLETE patched args object — use it
 *              in place of the original args when present
 *  - block     (tool.execute.before) abort the tool call with this message
 *  - decision  (permission.ask) auto-resolution; "deny" beats "allow"
 */
export interface HookResult {
  args?: any;
  block?: string;
  decision?: PermissionDecision;
}

export interface LoadedPlugin {
  file: string;
  hooks: string[];
}

export interface PluginError {
  file: string;
  message: string;
}

export interface LoadResult {
  loaded: LoadedPlugin[];
  errors: PluginError[];
}

// ---------------------------------------------------------------- state

interface Registered {
  file: string;
  hooks: HookMap;
}

let registry: Registered[] = [];

let logFn: (msg: string) => void = () => {};

/** Install the host's notice sink for ctx.log messages and hook errors. */
export function installPluginLogger(fn: (msg: string) => void): void {
  logFn = fn;
}

/** Reset the registry (tests / teardown). The installed logger is kept. */
export function clearPlugins(): void {
  registry = [];
}

// ---------------------------------------------------------------- loading

const home = () => process.env.GEARBOX_HOME || join(homedir(), ".gearbox");

const PLUGIN_EXTS = [".ts", ".tsx", ".js", ".mjs", ".cjs"];

/** Plugin files in one directory, alphabetical; "_"-prefixed files skipped. */
function pluginFiles(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // missing dir is normal — no plugins there
  }
  return names
    .filter((n) => !n.startsWith("_") && PLUGIN_EXTS.some((ext) => n.endsWith(ext)))
    .sort()
    .map((n) => join(dir, n));
}

// Unique per import so the file:// URL query actually changes between loads
// (cache-busting where the runtime honors it).
let importSeq = 0;

/**
 * Discover and load every plugin, replacing the current registry. Never
 * throws: each plugin failure (bad syntax, bad default export, throwing
 * factory) is collected in `errors` while the rest load normally.
 */
export async function loadPlugins(projectDir?: string): Promise<LoadResult> {
  const proj = resolve(projectDir ?? process.cwd());
  registry = [];
  const loaded: LoadedPlugin[] = [];
  const errors: PluginError[] = [];

  // Global first, then project — project plugins run last and win merges.
  // De-dupe in case both resolve to the same directory.
  const dirs = [...new Set([resolve(join(home(), "plugins")), resolve(join(proj, ".gearbox", "plugins"))])];
  const files = dirs.flatMap(pluginFiles);

  for (const file of files) {
    try {
      const url = `${pathToFileURL(file).href}?v=${Date.now()}.${importSeq++}`;
      const mod = await import(url);
      const factory: unknown = mod?.default;
      if (typeof factory !== "function") {
        throw new Error("plugin must default-export a function: (ctx) => HookMap");
      }
      const ctx: PluginContext = {
        projectDir: proj,
        log: (msg) => logFn(`[${basename(file)}] ${msg}`),
      };
      const hooks: HookMap = ((await (factory as Plugin)(ctx)) || {}) as HookMap;
      const names = Object.keys(hooks).filter((k) => typeof (hooks as Record<string, unknown>)[k] === "function");
      registry.push({ file, hooks });
      loaded.push({ file, hooks: names });
    } catch (e) {
      errors.push({ file, message: e instanceof Error ? e.message : String(e) });
    }
  }

  return { loaded, errors };
}

// ---------------------------------------------------------------- emitting

/**
 * Run every registered handler for `name` in load order and merge the results.
 * A throwing handler is logged via the installed logger and skipped — it never
 * breaks the agent. See HookResult for the merge rules.
 */
export async function emitHook<K extends HookName>(name: K, payload: HookPayloads[K]): Promise<HookResult> {
  const out: HookResult = {};
  let current = payload;

  for (const { file, hooks } of registry) {
    const fn = hooks[name];
    if (typeof fn !== "function") continue;
    try {
      const res = (await fn(current as any)) as { args?: any; block?: string; decision?: PermissionDecision } | void;
      if (!res || typeof res !== "object") continue;

      if (name === "tool.execute.before") {
        // Any block wins (first kept); later handlers still run (observe/log).
        if (typeof res.block === "string" && out.block === undefined) out.block = res.block;
        // Arg patches shallow-merge over the current args; subsequent handlers
        // see the patched args; `out.args` is always the complete final object.
        if (res.args && typeof res.args === "object") {
          const base = out.args ?? (payload as HookPayloads["tool.execute.before"]).args ?? {};
          out.args = { ...base, ...res.args };
          current = { ...(current as any), args: out.args };
        }
      } else if (name === "permission.ask") {
        // Deny beats allow, regardless of order.
        if (res.decision === "deny") out.decision = "deny";
        else if (res.decision === "allow" && out.decision !== "deny") out.decision = "allow";
      }
    } catch (e) {
      logFn(`[${basename(file)}] ${name} hook failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return out;
}
