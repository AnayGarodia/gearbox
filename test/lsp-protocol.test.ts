import { test, expect } from "bun:test";
import { encodeMessage, MessageReader } from "../src/lsp/protocol.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

test("encodeMessage frames with byte-accurate Content-Length (multibyte body)", () => {
  const obj = { method: "x", params: { s: "wörld 🦄 — ✓" } };
  const framed = encodeMessage(obj);
  const text = dec.decode(framed);
  const m = /^Content-Length: (\d+)\r\n\r\n/.exec(text);
  expect(m).not.toBeNull();
  const bodyBytes = enc.encode(JSON.stringify(obj)).length;
  expect(parseInt(m![1]!, 10)).toBe(bodyBytes);
  // string length ≠ byte length for this body — the header must count bytes
  expect(JSON.stringify(obj).length).not.toBe(bodyBytes);
});

test("roundtrip: encode → feed → same message", () => {
  const obj = { jsonrpc: "2.0", id: 1, method: "initialize", params: { a: [1, 2, 3] } };
  const r = new MessageReader();
  expect(r.feed(encodeMessage(obj))).toEqual([obj]);
  expect(r.pending).toBe(0);
});

test("multiple messages in one chunk", () => {
  const a = { id: 1, result: null };
  const b = { method: "textDocument/publishDiagnostics", params: { uri: "file:///x" } };
  const c = { id: 2, result: { ok: true } };
  const buf = new Uint8Array([...encodeMessage(a), ...encodeMessage(b), ...encodeMessage(c)]);
  const r = new MessageReader();
  expect(r.feed(buf)).toEqual([a, b, c]);
});

test("message split at EVERY byte boundary (covers split headers + utf8 multibyte)", () => {
  const obj = { method: "m", params: { s: "héllo 🦄 byte-böundary" } };
  const framed = encodeMessage(obj);
  for (let cut = 1; cut < framed.length; cut++) {
    const r = new MessageReader();
    const first = r.feed(framed.subarray(0, cut));
    const rest = r.feed(framed.subarray(cut));
    expect([...first, ...rest]).toEqual([obj]);
  }
});

test("one byte at a time across two messages", () => {
  const a = { id: 1, method: "a", params: { u: "✓✓✓" } };
  const b = { id: 2, method: "b" };
  const stream = new Uint8Array([...encodeMessage(a), ...encodeMessage(b)]);
  const r = new MessageReader();
  const got: unknown[] = [];
  for (let i = 0; i < stream.length; i++) got.push(...r.feed(stream.subarray(i, i + 1)));
  expect(got).toEqual([a, b]);
  expect(r.pending).toBe(0);
});

test("merged frames: complete message + partial second, completed later", () => {
  const a = { id: 1, result: "first" };
  const b = { id: 2, result: "second" };
  const fb = encodeMessage(b);
  const r = new MessageReader();
  const chunk1 = new Uint8Array([...encodeMessage(a), ...fb.subarray(0, 7)]);
  expect(r.feed(chunk1)).toEqual([a]);
  expect(r.pending).toBe(7);
  expect(r.feed(fb.subarray(7))).toEqual([b]);
});

test("extra headers (Content-Type) are tolerated, case-insensitive", () => {
  const body = JSON.stringify({ id: 9, result: 42 });
  const raw =
    `content-length: ${enc.encode(body).length}\r\n` +
    `Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n` +
    body;
  const r = new MessageReader();
  expect(r.feed(raw)).toEqual([{ id: 9, result: 42 }]);
});

test("string chunks work like byte chunks", () => {
  const obj = { method: "n", params: null };
  const r = new MessageReader();
  expect(r.feed(dec.decode(encodeMessage(obj)))).toEqual([obj]);
});

test("malformed header block is dropped; stream recovers", () => {
  const good = { id: 3, result: "ok" };
  const r = new MessageReader();
  const garbage = enc.encode("X-Nonsense: yes\r\n\r\n");
  const buf = new Uint8Array([...garbage, ...encodeMessage(good)]);
  expect(r.feed(buf)).toEqual([good]);
});

test("unparseable body is skipped; following message still parses", () => {
  const bad = "not json at all";
  const framedBad = enc.encode(`Content-Length: ${enc.encode(bad).length}\r\n\r\n${bad}`);
  const good = { id: 4, result: "after" };
  const r = new MessageReader();
  const out = r.feed(new Uint8Array([...framedBad, ...encodeMessage(good)]));
  expect(out).toEqual([good]);
});

test("empty body (Content-Length: 0) is skipped without wedging", () => {
  const r = new MessageReader();
  const zero = enc.encode("Content-Length: 0\r\n\r\n");
  const good = { id: 5, result: 1 };
  expect(r.feed(new Uint8Array([...zero, ...encodeMessage(good)]))).toEqual([good]);
});
