import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { which } from "../src/proc.ts";
import { LspClient } from "../src/lsp/client.ts";
import {
  SERVERS,
  detectServers,
  languageIdFor,
  serverForFile,
  type DetectedServer,
  type WhichImpl,
} from "../src/lsp/servers.ts";
import {
  checkFileDiagnostics,
  formatDiagnostics,
  shutdownAllLsp,
  type Diagnostic,
} from "../src/lsp/diagnostics.ts";

// ── fake LSP server (a Bun script speaking the protocol over stdio) ─────────

const FAKE_SRC = String.raw`// fake LSP server for tests: Content-Length framed JSON-RPC over stdio.
// argv[2] = mode: normal | silent | stubborn; argv[3] = optional start-log path.
const fs = require("node:fs");
const mode = process.argv[2] || "normal";
const logPath = process.argv[3];
if (logPath) fs.appendFileSync(logPath, "start\n");

let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const idx = buf.indexOf("\r\n\r\n");
    if (idx < 0) return;
    const m = /content-length:\s*(\d+)/i.exec(buf.slice(0, idx).toString("utf8"));
    const len = m ? parseInt(m[1], 10) : 0;
    if (buf.length < idx + 4 + len) return;
    const body = buf.slice(idx + 4, idx + 4 + len).toString("utf8");
    buf = buf.slice(idx + 4 + len);
    try { handle(JSON.parse(body)); } catch {}
  }
});
process.stdin.on("end", () => process.exit(0));

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  process.stdout.write("Content-Length: " + body.length + "\r\n\r\n");
  process.stdout.write(body);
}

const CANNED = [
  { range: { start: { line: 11, character: 4 }, end: { line: 11, character: 7 } }, severity: 1, code: 2304, source: "typescript", message: "Cannot find name 'foo'." },
  { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } }, severity: 2, code: 6133, source: "typescript", message: "'x' is declared but its value is never read." },
  { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 3, message: "informational only" },
  { range: { start: { line: 7, character: 2 }, end: { line: 7, character: 3 } }, source: "demo", code: "X1", message: "mystery" },
];

function publishFor(uri, text) {
  if (mode === "silent") return;
  // immediate empty publish, then the real set a beat later — exercises settle
  send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [] } });
  if (String(text).includes("CLEAN")) return;
  setTimeout(() => {
    send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: CANNED } });
  }, 80);
}

function handle(msg) {
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { textDocumentSync: 1 } } });
    // a server→client request: the client must answer or real servers stall
    send({ jsonrpc: "2.0", id: 9001, method: "workspace/configuration", params: { items: [{}] } });
  } else if (msg.method === "textDocument/didOpen") {
    publishFor(msg.params.textDocument.uri, msg.params.textDocument.text);
  } else if (msg.method === "textDocument/didChange") {
    publishFor(msg.params.textDocument.uri, msg.params.contentChanges[0].text);
  } else if (msg.method === "shutdown") {
    if (mode !== "stubborn") send({ jsonrpc: "2.0", id: msg.id, result: null });
  } else if (msg.method === "exit") {
    if (mode !== "stubborn") process.exit(0);
  }
}
`;

const tmp = mkdtempSync(join(tmpdir(), "gearbox-lsp-"));
const fakePath = join(tmp, "fake-lsp.js");
writeFileSync(fakePath, FAKE_SRC);

const bun = process.execPath; // the bun binary when running under `bun test`
const fakeCmd = (mode: string, log?: string) => [bun, "run", fakePath, mode, ...(log ? [log] : [])];

afterAll(async () => {
  await shutdownAllLsp();
  rmSync(tmp, { recursive: true, force: true });
});

// ── LspClient vs the fake server ────────────────────────────────────────────

test("LspClient: handshake, didOpen, settle waits past the early empty publish", async () => {
  const client = new LspClient({ command: fakeCmd("normal"), cwd: tmp });
  try {
    expect(await client.start()).toBe(true);
    const file = join(tmp, "direct.ts");
    client.didOpen(file, "const x = foo;", "typescript");
    const diags = await client.diagnosticsFor(file, { settleMs: 250, timeoutMs: 4000 });
    // the fake publishes [] immediately and the canned 4 at +80ms — settle must
    // return the LATE set, not the first empty one
    expect(diags.length).toBe(4);
    expect(diags[0]).toMatchObject({ line: 12, col: 5, severity: "error", source: "TS2304", message: "Cannot find name 'foo'." });
    expect(diags[1]).toMatchObject({ line: 3, col: 1, severity: "warning", source: "TS6133" });
    expect(diags[2]).toMatchObject({ line: 1, col: 1, severity: "info" });
    expect(diags[2]!.source).toBeUndefined();
    // missing severity → error; non-ts source+code folds as source(code)
    expect(diags[3]).toMatchObject({ line: 8, col: 3, severity: "error", source: "demo(X1)", message: "mystery" });
    expect(diags[0]!.path.endsWith("direct.ts")).toBe(true);

    // full-sync didChange to clean content: the stale-publish guard must not
    // return the pre-edit diagnostics
    client.didChange(file, "CLEAN content");
    expect(await client.diagnosticsFor(file, { settleMs: 250, timeoutMs: 4000 })).toEqual([]);

    expect(client.isOpen(file)).toBe(true);
    client.didClose(file);
    expect(client.isOpen(file)).toBe(false);
  } finally {
    await client.shutdown();
  }
  expect(client.alive).toBe(false);
}, 10000);

test("LspClient: missing binary degrades to note + empty diagnostics, never throws", async () => {
  const client = new LspClient({ command: ["gearbox-no-such-lsp-binary"], cwd: tmp });
  expect(await client.start(1500)).toBe(false);
  expect(client.note).toBeTruthy();
  expect(await client.diagnosticsFor(join(tmp, "x.ts"))).toEqual([]);
  await client.shutdown(); // must be safe to call anyway
}, 6000);

test("LspClient: diagnosticsFor times out gracefully when the server never publishes", async () => {
  const client = new LspClient({ command: fakeCmd("silent"), cwd: tmp });
  try {
    expect(await client.start()).toBe(true);
    const file = join(tmp, "s.ts");
    client.didOpen(file, "anything", "typescript");
    const t0 = Date.now();
    expect(await client.diagnosticsFor(file, { settleMs: 100, timeoutMs: 500 })).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(3000);
  } finally {
    await client.shutdown();
  }
}, 8000);

test("LspClient: shutdown SIGKILLs a server that ignores shutdown/exit", async () => {
  const client = new LspClient({ command: fakeCmd("stubborn"), cwd: tmp });
  expect(await client.start()).toBe(true);
  const t0 = Date.now();
  await client.shutdown({ requestTimeoutMs: 150, killAfterMs: 250 });
  expect(client.alive).toBe(false);
  expect(Date.now() - t0).toBeLessThan(3000);
}, 8000);

// ── servers.ts: detection with an injectable which ──────────────────────────

function fakeWhich(avail: string[]): WhichImpl {
  return (b) => (avail.includes(b) ? `/fake/bin/${b}` : null);
}

test("detectServers: needs project marker AND binary; binary preference order", () => {
  const dir = join(tmp, "ts-proj");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tsconfig.json"), "{}");
  expect(detectServers(dir, fakeWhich(["typescript-language-server", "vtsls"])).map((d) => d.command)).toEqual([
    ["/fake/bin/typescript-language-server", "--stdio"],
  ]);
  expect(detectServers(dir, fakeWhich(["vtsls"]))[0]!.command).toEqual(["/fake/bin/vtsls", "--stdio"]);
  expect(detectServers(dir, fakeWhich([]))).toEqual([]); // binary missing
  expect(detectServers(dir, fakeWhich(["gopls", "rust-analyzer"]))).toEqual([]); // wrong language's binaries
});

test("detectServers: python matches via pyproject.toml or any *.py in cwd", () => {
  const a = join(tmp, "py-marker");
  mkdirSync(a, { recursive: true });
  writeFileSync(join(a, "pyproject.toml"), "");
  expect(detectServers(a, fakeWhich(["pyright-langserver"])).map((d) => d.id)).toEqual(["python"]);

  const b = join(tmp, "py-scan");
  mkdirSync(b, { recursive: true });
  writeFileSync(join(b, "main.py"), "x = 1");
  const det = detectServers(b, fakeWhich(["basedpyright-langserver"]));
  expect(det.map((d) => d.command)).toEqual([["/fake/bin/basedpyright-langserver", "--stdio"]]);

  const c = join(tmp, "empty-proj");
  mkdirSync(c, { recursive: true });
  expect(detectServers(c, fakeWhich(["pyright-langserver"]))).toEqual([]); // no marker, no .py
});

test("detectServers: go.mod / Cargo.toml gate gopls and rust-analyzer (no --stdio)", () => {
  const dir = join(tmp, "go-rust");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "go.mod"), "module x");
  writeFileSync(join(dir, "Cargo.toml"), "[package]");
  const det = detectServers(dir, fakeWhich(["gopls", "rust-analyzer", "typescript-language-server"]));
  expect(det.map((d) => d.id)).toEqual(["go", "rust"]); // ts has no marker here
  expect(det.map((d) => d.command)).toEqual([["/fake/bin/gopls"], ["/fake/bin/rust-analyzer"]]);
});

test("serverForFile picks by extension; languageIdFor maps dialects", () => {
  const dir = join(tmp, "mixed");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tsconfig.json"), "{}");
  writeFileSync(join(dir, "app.py"), "");
  const det = detectServers(dir, fakeWhich(["typescript-language-server", "pyright-langserver"]));
  expect(serverForFile("/p/a.ts", det)?.id).toBe("typescript");
  expect(serverForFile("/p/a.TSX", det)?.id).toBe("typescript"); // case-insensitive ext
  expect(serverForFile("/p/a.py", det)?.id).toBe("python");
  expect(serverForFile("/p/a.md", det)).toBeNull();
  expect(languageIdFor("/p/a.ts", "typescript")).toBe("typescript");
  expect(languageIdFor("/p/a.tsx", "typescript")).toBe("typescriptreact");
  expect(languageIdFor("/p/a.mjs", "typescript")).toBe("javascript");
  expect(languageIdFor("/p/a.py", "python")).toBe("python");
  expect(languageIdFor("/p/a.rs", "rust")).toBe("rust");
});

// ── formatDiagnostics ───────────────────────────────────────────────────────

test("formatDiagnostics: compact model-facing block, cwd-relative paths", () => {
  const diags: Diagnostic[] = [
    { path: "/proj/src/x.ts", line: 12, col: 5, severity: "error", message: "Cannot find name 'foo'.", source: "TS2304" },
    { path: "/proj/src/y.ts", line: 3, col: 1, severity: "warning", message: "unused", source: "TS6133" },
    { path: "/elsewhere/z.ts", line: 1, col: 1, severity: "error", message: "boom" },
  ];
  expect(formatDiagnostics(diags, 10, "/proj").split("\n")).toEqual([
    "src/x.ts:12:5 error TS2304: Cannot find name 'foo'.",
    "src/y.ts:3:1 warning TS6133: unused",
    "/elsewhere/z.ts:1:1 error: boom", // outside cwd stays absolute; no source → bare severity
  ]);
});

test("formatDiagnostics: maxLines truncation + empty input", () => {
  const many: Diagnostic[] = Array.from({ length: 13 }, (_, i) => ({
    path: "a.ts",
    line: i + 1,
    col: 1,
    severity: "error" as const,
    message: `e${i}`,
  }));
  const lines = formatDiagnostics(many, 10, "/").split("\n");
  expect(lines.length).toBe(11);
  expect(lines[0]).toBe("a.ts:1:1 error: e0");
  expect(lines[10]).toBe("… and 3 more");
  expect(formatDiagnostics([], 10)).toBe("");
});

// ── checkFileDiagnostics: the seam, end-to-end against the fake server ──────

test("checkFileDiagnostics: ONE cached client per (server, root); filters info; sorts by line", async () => {
  const proj = join(tmp, "proj");
  mkdirSync(proj, { recursive: true });
  const log = join(tmp, "starts.log");
  const detect = (): DetectedServer[] => [{ id: "typescript", command: fakeCmd("normal", log), spec: SERVERS[0]! }];
  const file = join(proj, "src", "x.ts");

  const r1 = await checkFileDiagnostics(file, "const x = foo;", proj, { detect, settleMs: 250, timeoutMs: 4000 });
  expect(r1.note).toBeUndefined();
  // info severity filtered out; errors+warnings sorted by line
  expect(r1.diagnostics.map((d) => [d.line, d.severity])).toEqual([
    [3, "warning"],
    [8, "error"],
    [12, "error"],
  ]);

  // second call rides the SAME client (didChange path) — no new spawn
  const r2 = await checkFileDiagnostics(file, "CLEAN now", proj, { detect, settleMs: 250, timeoutMs: 4000 });
  expect(r2.diagnostics).toEqual([]);
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["start"]);
}, 15000);

test("checkFileDiagnostics: helpful notes when nothing matches; never throws", async () => {
  const proj = join(tmp, "noserver");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "tsconfig.json"), "{}");

  const none = await checkFileDiagnostics(join(proj, "a.ts"), "x", proj, { whichImpl: () => null });
  expect(none.diagnostics).toEqual([]);
  expect(none.note).toContain("typescript-language-server");

  const unknown = await checkFileDiagnostics(join(proj, "a.xyz"), "x", proj, { whichImpl: () => null });
  expect(unknown.note).toContain("no language server known");

  const thrown = await checkFileDiagnostics(join(proj, "a.ts"), "x", proj, {
    detect: () => {
      throw new Error("boom");
    },
  });
  expect(thrown.diagnostics).toEqual([]);
  expect(thrown.note).toContain("boom");
});

// ── optional integration test (skips unless typescript-language-server is on PATH)

const tlsBin = which("typescript-language-server");
(tlsBin ? test : test.skip)(
  "integration: real typescript-language-server flags a type error",
  async () => {
    // realpath: tsserver publishes /private/var/… for macOS tmp symlinks
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "gearbox-lsp-int-")));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "lsp-int", version: "0.0.0" }));
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
    const file = join(dir, "bad.ts");
    const content = "const n: number = 'oops';\nexport default n;\n";
    writeFileSync(file, content);
    try {
      const r = await checkFileDiagnostics(file, content, dir, { settleMs: 1000, timeoutMs: 20000 });
      expect(r.diagnostics.some((d) => d.severity === "error" && /not assignable/i.test(d.message))).toBe(true);
    } finally {
      await shutdownAllLsp();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30000,
);
