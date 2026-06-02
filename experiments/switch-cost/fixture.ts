// A realistic mid-session coding conversation as canonical state.
// Models what actually bloats real sessions: big file reads + full test output.
// Includes a POISONED fact (wrong early assumption) that later gets invalidated,
// to test context-poisoning recovery through the curation projection.

import type { CanonicalState } from "./canonical.ts";

const authTs = `// src/auth.ts
import { parseToken } from "./token";
import { getCookie } from "./http";

export function getSession(req: Request): Session | null {
  const raw = getCookie(req, "sid");
  if (!raw) return null;
  const token = parseToken(raw);
  if (!token) return null;
  // BUG: expiry compared in seconds against Date.now() (ms)
  if (token.exp < Date.now()) return null;
  return { userId: token.sub, exp: token.exp };
}

export function requireSession(req: Request): Session {
  const s = getSession(req);
  if (!s) throw new RedirectError("/login");
  return s;
}`;

const testOutput = `$ bun test auth.test.ts
auth.test.ts:
✓ getSession returns null with no cookie (1ms)
✓ getSession parses a valid token (2ms)
✗ getSession returns null for expired session (3ms)
  expected: null
  received: { userId: "u_123", exp: 1717200000 }
  at auth.test.ts:41:18
✗ requireSession redirects to /login when expired (1ms)
  expected RedirectError("/login")
  received: Session { userId: "u_123", exp: 1717200000 }
  at auth.test.ts:52:9
✗ session expiry boundary (off-by-one) (1ms)
  expected: null
  received: { userId: "u_123" ... }
 3 fail, 2 pass — ran 5 tests`;

const tokenTs = `// src/token.ts
export function parseToken(raw: string): Token | null {
  try {
    const [h, p, sig] = raw.split(".");
    const payload = JSON.parse(atob(p));
    if (!verify(h, p, sig)) return null;
    return { sub: payload.sub, exp: payload.exp }; // exp is in SECONDS (epoch)
  } catch { return null; }
}`;

export function buildFixture(): CanonicalState {
  return {
    system:
      "You are a coding agent operating in a TypeScript repo. Use tools to read files and run tests. Be precise; verify against test output.",
    openTask:
      "Fix the failing auth tests so an expired session returns null and requireSession redirects to /login.",
    tools: [
      {
        name: "read_file",
        description: "Read a file from the repo",
        parameters: { type: "object", properties: { path: { type: "string", description: "file path" } }, required: ["path"] },
      },
      {
        name: "run_tests",
        description: "Run a test file and return output",
        parameters: { type: "object", properties: { file: { type: "string", description: "test file" } }, required: ["file"] },
      },
      {
        name: "edit_file",
        description: "Apply an edit to a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" } },
          required: ["path", "find", "replace"],
        },
      },
    ],
    facts: [
      { id: "f1", text: "auth.test.ts has 3 failing tests, all about expired sessions.", provenance: "run_tests", valid: true },
      // POISONED: a plausible-but-wrong early assumption. Invalidated later.
      { id: "f2", text: "The bug is in parseToken — it must be returning a bad exp.", provenance: "inference", valid: false },
      { id: "f3", text: "parseToken returns exp in SECONDS (epoch).", provenance: "read_file token.ts", valid: true },
      { id: "f4", text: "Real bug: auth.ts compares token.exp (seconds) against Date.now() (ms). Must multiply exp by 1000.", provenance: "read_file auth.ts", valid: true },
    ],
    turns: [
      { kind: "user_text", text: "The auth tests are failing. Figure out why expired sessions aren't being rejected and fix it." },
      { kind: "thinking", text: "Start by running the tests to see the failures, then read the relevant files." },
      { kind: "assistant_text", text: "I'll run the auth tests first to see the failures." },
      { kind: "assistant_tool_call", callId: "c1", name: "run_tests", args: { file: "auth.test.ts" } },
      { kind: "tool_result", callId: "c1", name: "run_tests", result: testOutput },
      { kind: "thinking", text: "Three failures, all expiry-related. My first guess is parseToken is producing a wrong exp." },
      { kind: "assistant_text", text: "Three expiry tests fail. Let me check the token parser first." },
      { kind: "assistant_tool_call", callId: "c2", name: "read_file", args: { path: "src/token.ts" } },
      { kind: "tool_result", callId: "c2", name: "read_file", result: tokenTs },
      { kind: "thinking", text: "parseToken looks correct — exp is in seconds, by design. My earlier assumption (bug in parseToken) is wrong. The consumer must be mishandling the unit. Read auth.ts." },
      { kind: "assistant_text", text: "parseToken is fine — exp is epoch SECONDS by design. The bug must be in how auth.ts uses it. Reading auth.ts." },
      { kind: "assistant_tool_call", callId: "c3", name: "read_file", args: { path: "src/auth.ts" } },
      { kind: "tool_result", callId: "c3", name: "read_file", result: authTs },
      { kind: "assistant_text", text: "Found it: auth.ts compares token.exp (seconds) to Date.now() (milliseconds), so expired tokens look valid. Fix: compare token.exp * 1000 < Date.now()." },
      { kind: "assistant_tool_call", callId: "c4", name: "edit_file", args: { path: "src/auth.ts", find: "token.exp < Date.now()", replace: "token.exp * 1000 < Date.now()" } },
      { kind: "tool_result", callId: "c4", name: "edit_file", result: "Applied. auth.ts:11 updated." },
    ],
  };
}
