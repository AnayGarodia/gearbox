// LspClient — a minimal, diagnostics-only LSP client over stdio.
// HARD RULE: never throw to callers. Every failure path (spawn error, init
// timeout, server crash, broken pipe) degrades to empty diagnostics plus a
// human-readable `note`, so the agent loop stays alive no matter what the
// language server does.
import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnProc, type Proc } from "../proc.ts";
import { encodeMessage, MessageReader, type JsonRpcMessage } from "./protocol.ts";

export type DiagnosticSeverity = "error" | "warning" | "info" | "hint";

export interface Diagnostic {
  path: string;
  /** 1-based (LSP is 0-based; converted at the boundary). */
  line: number;
  /** 1-based. */
  col: number;
  severity: DiagnosticSeverity;
  message: string;
  source?: string;
}

const SEVERITIES: Record<number, DiagnosticSeverity> = { 1: "error", 2: "warning", 3: "info", 4: "hint" };

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Normalize a path for use as a map key. realpath matters on macOS where the
// server may publish /private/var/... for a file we opened as /var/... —
// both sides of the map (didOpen key + publishDiagnostics uri) go through this.
// Falls back to resolve() for files that don't exist on disk (in-memory opens).
function normPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Fold LSP source+code into one display tag: typescript+2304 → "TS2304". */
function foldSource(source: unknown, code: unknown): string | undefined {
  const c = code != null && typeof code === "object" ? (code as { value?: unknown }).value : code;
  const src = typeof source === "string" && source !== "" ? source : undefined;
  if (c == null || c === "") return src;
  if (src && /^(ts|typescript|tsserver)$/i.test(src)) return `TS${c}`;
  return src ? `${src}(${c})` : String(c);
}

/**
 * Normalize an LSP definition/references result — Location | Location[] |
 * LocationLink[] | null — into 1-based path/line/col triples. Exported for tests.
 */
export function normalizeLocations(result: unknown): { path: string; line: number; col: number }[] {
  const arr = result == null ? [] : Array.isArray(result) ? result : [result];
  const out: { path: string; line: number; col: number }[] = [];
  for (const loc of arr) {
    if (!loc || typeof loc !== "object") continue;
    const l = loc as any;
    const uri: unknown = l.uri ?? l.targetUri;
    const range = l.range ?? l.targetSelectionRange ?? l.targetRange;
    if (typeof uri !== "string") continue;
    let path: string;
    try {
      path = uri.startsWith("file:") ? normPath(fileURLToPath(uri)) : uri;
    } catch {
      path = uri;
    }
    out.push({
      path,
      line: (range?.start?.line ?? 0) + 1,
      col: (range?.start?.character ?? 0) + 1,
    });
  }
  return out;
}

export interface DiagnosticsWait {
  /** Resolve once no new publish has arrived for this long. */
  settleMs?: number;
  /** Hard cap on the total wait. */
  timeoutMs?: number;
}

export class LspClient {
  /** Set on any degradation (spawn failure, init timeout, crash) — surfaced to callers. */
  note?: string;

  private proc: Proc | null = null;
  private reader = new MessageReader();
  private nextId = 1;
  private pending = new Map<number | string, (msg: JsonRpcMessage | undefined) => void>();
  private store = new Map<string, { diags: Diagnostic[]; at: number }>();
  private lastEditAt = new Map<string, number>();
  private versions = new Map<string, number>();
  private dead = false;
  private shuttingDown = false;
  private startP: Promise<boolean> | null = null;

  constructor(private opts: { command: string[]; cwd: string }) {}

  get alive(): boolean {
    return this.proc !== null && !this.dead;
  }

  isOpen(absPath: string): boolean {
    return this.versions.has(normPath(absPath));
  }

  /** Spawn + initialize handshake. Memoized: concurrent callers share one startup. */
  start(initTimeoutMs = 8000): Promise<boolean> {
    this.startP ??= this.doStart(initTimeoutMs);
    return this.startP;
  }

  private async doStart(initTimeoutMs: number): Promise<boolean> {
    const bin = this.opts.command[0] ?? "(empty command)";
    try {
      this.proc = spawnProc(this.opts.command, {
        cwd: this.opts.cwd,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      });
    } catch (e) {
      this.dead = true;
      this.note = `could not start ${bin}: ${errText(e)}`;
      return false;
    }
    if (!this.proc.stdin || !this.proc.stdout) {
      this.note = `could not start ${bin}: no stdio pipes`;
      this.kill();
      return false;
    }
    void this.proc.exited.then(() => this.onExit(bin));
    void this.pump(this.proc.stdout);

    const rootUri = pathToFileURL(this.opts.cwd).href;
    const res = await this.request(
      "initialize",
      {
        processId: process.pid,
        rootUri,
        rootPath: this.opts.cwd,
        capabilities: { textDocument: { publishDiagnostics: {}, definition: {}, references: {} } },
        workspaceFolders: [{ uri: rootUri, name: basename(this.opts.cwd) }],
      },
      initTimeoutMs,
    );
    if (!res || res.error || this.dead) {
      this.note ??= res?.error
        ? `${bin} rejected initialize: ${res.error.message}`
        : `${bin} did not complete the initialize handshake`;
      this.kill();
      return false;
    }
    this.notify("initialized", {});
    return true;
  }

  // ── document sync (full-text) ─────────────────────────────────────────────

  didOpen(absPath: string, text: string, languageId: string, version = 1): void {
    const key = normPath(absPath);
    this.versions.set(key, version);
    this.lastEditAt.set(key, Date.now());
    this.notify("textDocument/didOpen", {
      textDocument: { uri: pathToFileURL(key).href, languageId, version, text },
    });
  }

  /** Full-document sync: one change event with no range replaces the whole text. */
  didChange(absPath: string, text: string): void {
    const key = normPath(absPath);
    const version = (this.versions.get(key) ?? 0) + 1;
    this.versions.set(key, version);
    this.lastEditAt.set(key, Date.now());
    this.notify("textDocument/didChange", {
      textDocument: { uri: pathToFileURL(key).href, version },
      contentChanges: [{ text }],
    });
  }

  didClose(absPath: string): void {
    const key = normPath(absPath);
    this.versions.delete(key);
    this.lastEditAt.delete(key);
    this.store.delete(key);
    this.notify("textDocument/didClose", { textDocument: { uri: pathToFileURL(key).href } });
  }

  // ── diagnostics ───────────────────────────────────────────────────────────

  /**
   * Wait until diagnostics for this file SETTLE — a publish newer than the
   * last didOpen/didChange, with no further publish for `settleMs` — or until
   * `timeoutMs` elapses, then return what we have. Never throws; a dead client
   * (or a server that never publishes) returns [].
   */
  async diagnosticsFor(absPath: string, wait: DiagnosticsWait = {}): Promise<Diagnostic[]> {
    const { settleMs = 1500, timeoutMs = 5000 } = wait;
    const key = normPath(absPath);
    const editAt = this.lastEditAt.get(key) ?? 0;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.dead) break;
      const rec = this.store.get(key);
      const now = Date.now();
      // rec.at >= editAt guards against returning a STALE publish from before
      // the didChange we just sent.
      if (rec && rec.at >= editAt && now - rec.at >= settleMs) break;
      if (now >= deadline) break;
      await sleep(Math.min(25, Math.max(1, deadline - now)));
    }
    return this.store.get(key)?.diags ?? [];
  }

  // ── symbol navigation ─────────────────────────────────────────────────────

  /**
   * textDocument/definition or /references at a 1-based (line, col). Returns
   * normalized 1-based locations; [] on any failure or timeout (never throws).
   * The file must have been didOpen'd first so the server has its content.
   */
  async locations(
    kind: "definition" | "references",
    absPath: string,
    line: number,
    col: number,
    timeoutMs = 5000,
  ): Promise<{ path: string; line: number; col: number }[]> {
    const uri = pathToFileURL(normPath(absPath)).href;
    const params: Record<string, unknown> = {
      textDocument: { uri },
      position: { line: Math.max(0, line - 1), character: Math.max(0, col - 1) },
    };
    if (kind === "references") params.context = { includeDeclaration: true };
    const res = await this.request(`textDocument/${kind}`, params, timeoutMs);
    return normalizeLocations(res?.result);
  }

  // ── shutdown ──────────────────────────────────────────────────────────────

  /** shutdown request → exit notification → SIGKILL failsafe. Never throws. */
  async shutdown(opts: { requestTimeoutMs?: number; killAfterMs?: number } = {}): Promise<void> {
    const { requestTimeoutMs = 1000, killAfterMs = 2000 } = opts;
    const proc = this.proc;
    if (!proc) return;
    this.shuttingDown = true;
    try {
      if (!this.dead) {
        await this.request("shutdown", null, requestTimeoutMs);
        this.notify("exit");
      }
      const exited = await Promise.race([
        proc.exited.then(() => true),
        sleep(killAfterMs).then(() => false),
      ]);
      if (!exited) proc.kill("SIGKILL");
    } catch {
      // never throw from shutdown
    }
    this.dead = true;
  }

  private kill(): void {
    this.shuttingDown = true;
    this.proc?.kill("SIGKILL");
    this.dead = true;
  }

  // ── plumbing ──────────────────────────────────────────────────────────────

  private onExit(bin: string): void {
    this.dead = true;
    if (!this.shuttingDown) this.note ??= `${bin} exited unexpectedly`;
    for (const fn of this.pending.values()) fn(undefined);
    this.pending.clear();
  }

  private async pump(stdout: NodeJS.ReadableStream): Promise<void> {
    try {
      for await (const chunk of stdout) {
        for (const msg of this.reader.feed(chunk)) this.dispatch(msg);
      }
    } catch {
      // stream torn down — death is handled via proc.exited
    }
  }

  private dispatch(msg: JsonRpcMessage): void {
    if (msg.method !== undefined && msg.id !== undefined && msg.id !== null) {
      // Server→client REQUEST: answer minimally so the server never stalls on
      // us (typescript-language-server sends workspace/configuration,
      // window/workDoneProgress/create, client/registerCapability, …).
      let result: unknown = null;
      if (msg.method === "workspace/configuration") {
        const n = Array.isArray(msg.params?.items) ? msg.params.items.length : 0;
        result = new Array(n).fill(null);
      }
      this.write({ jsonrpc: "2.0", id: msg.id, result });
      return;
    }
    if (msg.id !== undefined && msg.id !== null) {
      // Response to one of our requests.
      const fn = this.pending.get(msg.id);
      if (fn) {
        this.pending.delete(msg.id);
        fn(msg);
      }
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics") this.onPublish(msg.params);
    // All other notifications ($/progress, window/logMessage, …) are ignored.
  }

  private onPublish(params: any): void {
    const uri = typeof params?.uri === "string" ? params.uri : null;
    if (!uri) return;
    let path: string;
    try {
      path = uri.startsWith("file:") ? normPath(fileURLToPath(uri)) : uri;
    } catch {
      path = uri;
    }
    const raw: any[] = Array.isArray(params?.diagnostics) ? params.diagnostics : [];
    const diags: Diagnostic[] = raw.map((d) => ({
      path,
      line: (d?.range?.start?.line ?? 0) + 1,
      col: (d?.range?.start?.character ?? 0) + 1,
      severity: SEVERITIES[d?.severity as number] ?? "error",
      message: typeof d?.message === "string" ? d.message : String(d?.message ?? ""),
      source: foldSource(d?.source, d?.code),
    }));
    this.store.set(path, { diags, at: Date.now() });
  }

  private write(obj: unknown): void {
    if (this.dead || !this.proc?.stdin || this.proc.exitCode !== null) return;
    try {
      this.proc.stdin.write(encodeMessage(obj));
    } catch {
      // pipe gone — the exit handler will mark us dead
    }
  }

  private notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<JsonRpcMessage | undefined> {
    return new Promise((res) => {
      if (this.dead || !this.proc?.stdin) return res(undefined);
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        res(undefined);
      }, timeoutMs);
      this.pending.set(id, (m) => {
        clearTimeout(timer);
        res(m);
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }
}
