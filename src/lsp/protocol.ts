// JSON-RPC 2.0 over stdio framing — the LSP base protocol. PURE: bytes in,
// parsed messages out. No I/O, no process handles, so it is trivially
// unit-testable (split frames, merged frames, utf-8 multibyte boundaries).
//
// Wire format per message:
//   Content-Length: <byte count of body>\r\n
//   [optional other headers, e.g. Content-Type]\r\n
//   \r\n
//   <Content-Length bytes of UTF-8 JSON>
//
// GOTCHA: Content-Length counts BYTES of the UTF-8 body, not JS string length —
// so the reader must buffer raw bytes and only decode complete bodies, or a
// chunk split inside a multibyte character corrupts the stream.

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

/** Frame a message: Content-Length header + UTF-8 JSON body. */
export function encodeMessage(obj: unknown): Uint8Array {
  const body = encoder.encode(JSON.stringify(obj));
  const header = encoder.encode(`Content-Length: ${body.length}\r\n\r\n`);
  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0);
  out.set(body, header.length);
  return out;
}

// \r\n\r\n as bytes — searched on the raw buffer (never decode incomplete bytes).
const CR = 13;
const LF = 10;

function indexOfHeaderEnd(buf: Uint8Array): number {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === CR && buf[i + 1] === LF && buf[i + 2] === CR && buf[i + 3] === LF) return i;
  }
  return -1;
}

/**
 * Incremental frame reader. feed() arbitrary chunks (split or merged frames,
 * any byte boundary) and get back every COMPLETE message; partial frames stay
 * buffered until the next feed. Malformed headers/bodies are dropped without
 * wedging the stream.
 */
export class MessageReader {
  private buf: Uint8Array = new Uint8Array(0);

  feed(chunk: Uint8Array | string): JsonRpcMessage[] {
    const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
    if (this.buf.length === 0) {
      this.buf = bytes.slice(); // copy — callers (Node streams) may reuse the buffer
    } else {
      const next = new Uint8Array(this.buf.length + bytes.length);
      next.set(this.buf, 0);
      next.set(bytes, this.buf.length);
      this.buf = next;
    }

    const out: JsonRpcMessage[] = [];
    for (;;) {
      const hEnd = indexOfHeaderEnd(this.buf);
      if (hEnd < 0) break; // header not complete yet
      const headerText = decoder.decode(this.buf.subarray(0, hEnd));
      const m = /content-length:\s*(\d+)/i.exec(headerText);
      if (!m) {
        // Malformed header block: drop it and keep scanning rather than wedging.
        this.buf = this.buf.slice(hEnd + 4);
        continue;
      }
      const len = parseInt(m[1]!, 10);
      const total = hEnd + 4 + len;
      if (this.buf.length < total) break; // body not complete yet
      const body = this.buf.subarray(hEnd + 4, total);
      this.buf = this.buf.slice(total); // slice() compacts (drops the old backing buffer)
      try {
        out.push(JSON.parse(decoder.decode(body)) as JsonRpcMessage);
      } catch {
        // Unparseable body: skip this frame, keep the stream alive.
      }
    }
    return out;
  }

  /** Bytes currently buffered (an incomplete frame), for tests/debugging. */
  get pending(): number {
    return this.buf.length;
  }
}
