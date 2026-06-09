import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { clearPlugins, emitHook, installPluginLogger, loadPlugins } from "../src/plugins.ts";

// Each test gets fresh temp dirs (unique paths matter: Bun caches modules by
// path, so plugin files must never be re-written at a previously-imported path).
let home: string;
let project: string;
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.GEARBOX_HOME;
  home = mkdtempSync(join(tmpdir(), "gearbox-plugins-home-"));
  project = mkdtempSync(join(tmpdir(), "gearbox-plugins-proj-"));
  process.env.GEARBOX_HOME = home;
  clearPlugins();
  installPluginLogger(() => {});
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.GEARBOX_HOME;
  else process.env.GEARBOX_HOME = prevHome;
  clearPlugins();
  installPluginLogger(() => {});
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

const projDir = () => {
  const d = join(project, ".gearbox", "plugins");
  mkdirSync(d, { recursive: true });
  return d;
};
const globalDir = () => {
  const d = join(home, "plugins");
  mkdirSync(d, { recursive: true });
  return d;
};
const write = (dir: string, name: string, src: string) => {
  const file = join(dir, name);
  writeFileSync(file, src);
  return file;
};

// ---------------------------------------------------------------- loading

test("loads project + global plugins and reports their hook names", async () => {
  write(globalDir(), "a.ts", `export default () => ({ "session.start": () => {} });`);
  write(
    projDir(),
    "b.ts",
    `export default () => ({ "tool.execute.before": () => {}, "file.edited": () => {} });`,
  );

  const res = await loadPlugins(project);
  expect(res.errors).toEqual([]);
  expect(res.loaded.length).toBe(2);
  expect(res.loaded.map((l) => basename(l.file))).toEqual(["a.ts", "b.ts"]);
  expect(res.loaded[0]!.hooks).toEqual(["session.start"]);
  expect(res.loaded[1]!.hooks!.sort()).toEqual(["file.edited", "tool.execute.before"]);
});

test("missing plugin dirs → empty result, no errors", async () => {
  const res = await loadPlugins(project);
  expect(res).toEqual({ loaded: [], errors: [] });
});

test("load order: global before project, alphabetical within a dir; handlers run in that order", async () => {
  (globalThis as any).__gbxOrder = [];
  const push = (tag: string) =>
    `export default () => ({ "session.start": () => { (globalThis as any).__gbxOrder.push("${tag}"); } });`;
  // written out of alphabetical order on purpose
  write(projDir(), "b.ts", push("proj-b"));
  write(projDir(), "a.ts", push("proj-a"));
  write(globalDir(), "g.ts", push("global-g"));

  const res = await loadPlugins(project);
  expect(res.errors).toEqual([]);
  expect(res.loaded.map((l) => basename(l.file))).toEqual(["g.ts", "a.ts", "b.ts"]);

  await emitHook("session.start", { sessionId: "s1" });
  expect((globalThis as any).__gbxOrder).toEqual(["global-g", "proj-a", "proj-b"]);
});

test("a syntactically broken plugin is collected in errors without throwing; others still load", async () => {
  const dir = projDir();
  write(dir, "broken.ts", `export default (ctx => { this is not valid typescript`);
  write(dir, "ok.ts", `export default () => ({ "turn.end": () => {} });`);

  const res = await loadPlugins(project);
  expect(res.loaded.length).toBe(1);
  expect(basename(res.loaded[0]!.file)).toBe("ok.ts");
  expect(res.errors.length).toBe(1);
  expect(basename(res.errors[0]!.file)).toBe("broken.ts");
  expect(res.errors[0]!.message.length).toBeGreaterThan(0);
});

test("a plugin without a function default export is an error", async () => {
  write(projDir(), "bad-export.ts", `export default 42;`);
  const res = await loadPlugins(project);
  expect(res.loaded).toEqual([]);
  expect(res.errors.length).toBe(1);
  expect(res.errors[0]!.message).toContain("default-export a function");
});

test("a throwing plugin factory is collected in errors", async () => {
  write(projDir(), "boom.ts", `export default () => { throw new Error("boom at setup"); };`);
  const res = await loadPlugins(project);
  expect(res.loaded).toEqual([]);
  expect(res.errors.length).toBe(1);
  expect(res.errors[0]!.message).toBe("boom at setup");
});

test("files starting with _ and non-code files are skipped", async () => {
  const dir = projDir();
  write(dir, "_helper.ts", `this would be a syntax error if loaded(((`);
  write(dir, "notes.md", `# not a plugin`);
  write(dir, "real.ts", `export default () => ({ "file.edited": () => {} });`);

  const res = await loadPlugins(project);
  expect(res.errors).toEqual([]);
  expect(res.loaded.map((l) => basename(l.file))).toEqual(["real.ts"]);
});

test("a factory returning nothing still loads, with no hooks", async () => {
  write(projDir(), "empty.ts", `export default () => {};`);
  const res = await loadPlugins(project);
  expect(res.errors).toEqual([]);
  expect(res.loaded.length).toBe(1);
  expect(res.loaded[0]!.hooks).toEqual([]);
});

test("an async factory is awaited", async () => {
  write(
    projDir(),
    "async.ts",
    `export default async () => { await new Promise((r) => setTimeout(r, 5)); return { "session.start": () => {} }; };`,
  );
  const res = await loadPlugins(project);
  expect(res.errors).toEqual([]);
  expect(res.loaded[0]!.hooks).toEqual(["session.start"]);
});

test("ctx.log routes to the installed logger, prefixed with the plugin file", async () => {
  const msgs: string[] = [];
  installPluginLogger((m) => msgs.push(m));
  write(projDir(), "logger.ts", `export default (ctx) => { ctx.log("hello from plugin"); };`);

  await loadPlugins(project);
  expect(msgs.length).toBe(1);
  expect(msgs[0]).toContain("logger.ts");
  expect(msgs[0]).toContain("hello from plugin");
});

test("reloading replaces the registry: no duplicate handlers, new files picked up", async () => {
  (globalThis as any).__gbxCount = 0;
  const dir = projDir();
  write(dir, "count-a.ts", `export default () => ({ "session.start": () => { (globalThis as any).__gbxCount++; } });`);

  await loadPlugins(project);
  await loadPlugins(project); // again — must not double-register
  await emitHook("session.start", { sessionId: "s" });
  expect((globalThis as any).__gbxCount).toBe(1);

  // a newly added plugin file is picked up by the next load
  write(dir, "count-b.ts", `export default () => ({ "session.start": () => { (globalThis as any).__gbxCount++; } });`);
  await loadPlugins(project);
  (globalThis as any).__gbxCount = 0;
  await emitHook("session.start", { sessionId: "s" });
  expect((globalThis as any).__gbxCount).toBe(2);
});

test("clearPlugins resets the registry", async () => {
  write(projDir(), "block.ts", `export default () => ({ "tool.execute.before": () => ({ block: "no" }) });`);
  await loadPlugins(project);
  expect((await emitHook("tool.execute.before", { tool: "run_shell", args: {} })).block).toBe("no");

  clearPlugins();
  expect((await emitHook("tool.execute.before", { tool: "run_shell", args: {} })).block).toBeUndefined();
});

// ---------------------------------------------------------------- emitting

test("tool.execute.before: a plugin can block run_shell on rm -rf", async () => {
  write(
    projDir(),
    "guard.ts",
    `export default () => ({
      "tool.execute.before": ({ tool, args }) => {
        if (tool === "run_shell" && typeof args?.command === "string" && args.command.includes("rm -rf"))
          return { block: "dangerous command blocked by guard plugin" };
      },
    });`,
  );
  await loadPlugins(project);

  const blocked = await emitHook("tool.execute.before", { tool: "run_shell", args: { command: "rm -rf /tmp/x" } });
  expect(blocked.block).toBe("dangerous command blocked by guard plugin");

  const fine = await emitHook("tool.execute.before", { tool: "run_shell", args: { command: "ls -la" } });
  expect(fine.block).toBeUndefined();

  const otherTool = await emitHook("tool.execute.before", { tool: "read_file", args: { path: "rm -rf" } });
  expect(otherTool.block).toBeUndefined();
});

test("tool.execute.before: arg patches shallow-merge in load order; later handlers see patched args", async () => {
  (globalThis as any).__gbxSeen = null;
  write(
    globalDir(),
    "patch1.ts",
    `export default () => ({ "tool.execute.before": () => ({ args: { a: 1, shared: "first" } }) });`,
  );
  write(
    projDir(),
    "patch2.ts",
    `export default () => ({
      "tool.execute.before": ({ args }) => {
        (globalThis as any).__gbxSeen = { ...args };
        return { args: { shared: "second", b: 2 } };
      },
    });`,
  );
  await loadPlugins(project);

  const res = await emitHook("tool.execute.before", { tool: "run_shell", args: { base: true, shared: "orig" } });
  // patch2 (loaded later) saw patch1's merge applied
  expect((globalThis as any).__gbxSeen).toEqual({ base: true, a: 1, shared: "first" });
  // final args = original ⊕ patch1 ⊕ patch2 (later wins on conflicts)
  expect(res.args).toEqual({ base: true, a: 1, shared: "second", b: 2 });
  expect(res.block).toBeUndefined();
});

test("tool.execute.before: any block wins (first kept); later handlers still run", async () => {
  (globalThis as any).__gbxRan = [];
  write(
    globalDir(),
    "block1.ts",
    `export default () => ({ "tool.execute.before": () => { (globalThis as any).__gbxRan.push(1); return { block: "first block" }; } });`,
  );
  write(
    projDir(),
    "block2.ts",
    `export default () => ({ "tool.execute.before": () => { (globalThis as any).__gbxRan.push(2); return { block: "second block" }; } });`,
  );
  await loadPlugins(project);

  const res = await emitHook("tool.execute.before", { tool: "run_shell", args: {} });
  expect(res.block).toBe("first block");
  expect((globalThis as any).__gbxRan).toEqual([1, 2]); // both ran
});

test("a throwing hook is isolated: logged, other hooks still run, emitHook resolves", async () => {
  const msgs: string[] = [];
  installPluginLogger((m) => msgs.push(m));
  write(
    globalDir(),
    "thrower.ts",
    `export default () => ({ "tool.execute.before": () => { throw new Error("hook exploded"); } });`,
  );
  write(
    projDir(),
    "survivor.ts",
    `export default () => ({ "tool.execute.before": () => ({ args: { ok: true } }) });`,
  );
  await loadPlugins(project);

  const res = await emitHook("tool.execute.before", { tool: "edit_file", args: {} });
  expect(res.args).toEqual({ ok: true }); // survivor still ran and merged
  expect(res.block).toBeUndefined();
  const errLog = msgs.find((m) => m.includes("hook exploded"));
  expect(errLog).toBeDefined();
  expect(errLog).toContain("thrower.ts");
});

test("async hooks are awaited and merged", async () => {
  write(
    projDir(),
    "slow.ts",
    `export default () => ({
      "tool.execute.before": async () => {
        await new Promise((r) => setTimeout(r, 5));
        return { args: { patched: true } };
      },
    });`,
  );
  await loadPlugins(project);
  const res = await emitHook("tool.execute.before", { tool: "write_file", args: { x: 1 } });
  expect(res.args).toEqual({ x: 1, patched: true });
});

test("permission.ask: a plugin can auto-allow", async () => {
  write(projDir(), "allow.ts", `export default () => ({ "permission.ask": () => ({ decision: "allow" }) });`);
  await loadPlugins(project);
  const res = await emitHook("permission.ask", { kind: "write", title: "write file" });
  expect(res.decision).toBe("allow");
});

test("permission.ask: deny wins over allow regardless of order", async () => {
  write(globalDir(), "deny.ts", `export default () => ({ "permission.ask": () => ({ decision: "deny" }) });`);
  write(projDir(), "z-allow.ts", `export default () => ({ "permission.ask": () => ({ decision: "allow" }) });`);
  await loadPlugins(project);
  const res = await emitHook("permission.ask", { kind: "shell", title: "run command", detail: "rm -rf /" });
  expect(res.decision).toBe("deny");
});

test("permission.ask: no decision when no plugin decides", async () => {
  write(projDir(), "watch.ts", `export default () => ({ "permission.ask": () => {} });`);
  await loadPlugins(project);
  const res = await emitHook("permission.ask", { kind: "write", title: "write file" });
  expect(res.decision).toBeUndefined();
});

test("observe-only hooks receive their payloads", async () => {
  (globalThis as any).__gbxObserved = [];
  write(
    projDir(),
    "observer.ts",
    `export default () => ({
      "tool.execute.after": (p) => { (globalThis as any).__gbxObserved.push(["after", p]); },
      "file.edited": (p) => { (globalThis as any).__gbxObserved.push(["edited", p]); },
      "turn.end": (p) => { (globalThis as any).__gbxObserved.push(["turn", p]); },
    });`,
  );
  await loadPlugins(project);

  await emitHook("tool.execute.after", { tool: "run_shell", args: { command: "ls" }, result: "ok", durationMs: 12 });
  await emitHook("file.edited", { path: "/tmp/a.ts" });
  await emitHook("turn.end", { changedFiles: ["/tmp/a.ts"], hadError: false });

  expect((globalThis as any).__gbxObserved).toEqual([
    ["after", { tool: "run_shell", args: { command: "ls" }, result: "ok", durationMs: 12 }],
    ["edited", { path: "/tmp/a.ts" }],
    ["turn", { changedFiles: ["/tmp/a.ts"], hadError: false }],
  ]);
});

test("emitHook with no plugins loaded resolves to an empty result", async () => {
  const res = await emitHook("tool.execute.before", { tool: "run_shell", args: { command: "ls" } });
  expect(res).toEqual({});
});
