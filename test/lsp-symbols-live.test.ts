// Round-trip the new symbol-navigation path against a fake LSP server
// (Content-Length framed JSON-RPC over stdio, like lsp-diagnostics.test.ts).
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LspClient } from "../src/lsp/client.ts";
import { symbolLocations } from "../src/lsp/symbols.ts";
import { shutdownAllLsp } from "../src/lsp/diagnostics.ts";
import type { DetectedServer } from "../src/lsp/servers.ts";

const FAKE_SRC = String.raw`const fs = require("node:fs");
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
function handle(msg) {
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { definitionProvider: true, referencesProvider: true } } });
  } else if (msg.method === "textDocument/definition") {
    // echo back a LocationLink pointing into the same doc at the requested position
    const uri = msg.params.textDocument.uri;
    send({ jsonrpc: "2.0", id: msg.id, result: [{ targetUri: uri, targetSelectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } } }] });
  } else if (msg.method === "textDocument/references") {
    const uri = msg.params.textDocument.uri;
    send({ jsonrpc: "2.0", id: msg.id, result: [
      { uri, range: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } } },
      { uri, range: { start: { line: 1, character: 12 }, end: { line: 1, character: 15 } } },
    ] });
  } else if (msg.method === "shutdown") {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
  } else if (msg.method === "exit") {
    process.exit(0);
  }
}
`;

const tmp = mkdtempSync(join(tmpdir(), "gearbox-lsp-sym-"));
const fakePath = join(tmp, "fake-lsp.js");
writeFileSync(fakePath, FAKE_SRC);
const bun = process.execPath;

afterAll(async () => {
  await shutdownAllLsp();
  rmSync(tmp, { recursive: true, force: true });
});

test("LspClient.locations: definition + references round-trip, 1-based", async () => {
  const client = new LspClient({ command: [bun, "run", fakePath], cwd: tmp });
  try {
    expect(await client.start()).toBe(true);
    const file = join(tmp, "a.ts");
    client.didOpen(file, "function foo() {}\nconst bar = foo()", "typescript");
    const defs = await client.locations("definition", file, 2, 13);
    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({ line: 1, col: 10 });
    expect(defs[0]!.path.endsWith("a.ts")).toBe(true);
    const refs = await client.locations("references", file, 1, 10);
    expect(refs).toHaveLength(2);
    expect(refs[1]).toMatchObject({ line: 2, col: 13 });
  } finally {
    await client.shutdown();
  }
}, 10000);

test("symbolLocations: name → position → locations with context text", async () => {
  const file = join(tmp, "b.ts");
  writeFileSync(file, "function foo() {}\nconst bar = foo()\n");
  const detect = (): DetectedServer[] => [
    { id: "typescript", command: [bun, "run", fakePath], spec: { id: "typescript", binaries: [], args: [], extensions: [".ts"], markers: [] } },
  ];
  const { locations, note } = await symbolLocations("references", file, "foo", tmp, { detect });
  expect(note ?? "").toBe("");
  expect(locations).toHaveLength(2);
  expect(locations[0]!.text).toBe("function foo() {}");
  expect(locations[1]!.text).toBe("const bar = foo()");
}, 10000);

test("symbolLocations: degrades when the symbol is absent", async () => {
  const file = join(tmp, "c.ts");
  writeFileSync(file, "const x = 1\n");
  const { locations, note } = await symbolLocations("definition", file, "missingSym", tmp, { detect: () => [] });
  expect(locations).toEqual([]);
  expect(note).toContain("does not appear");
}, 5000);
