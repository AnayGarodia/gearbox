// Generate sessions of increasing length to measure how full-transcript cost
// vs curated-projection cost SCALE. The architectural claim: curated size is
// ~bounded (facts ledger + last K turns), raw transcript is O(session length).
// So the switch-cost advantage should GROW with session length, not stay flat.

import type { CanonicalState, Turn, Fact } from "./canonical.ts";

// realistic chunky tool output, varied per cycle so it's not trivially compressible
function fileBlob(i: number): string {
  return `// src/module_${i}.ts
import { load } from "./store_${i}";
export class Service_${i} {
  constructor(private deps: Deps_${i}) {}
  async handle(req: Req): Promise<Res> {
    const ctx = await load(req.id);
    if (!ctx) throw new NotFound("module_${i}");
    const out = this.deps.transform(ctx, req.payload);
    // edge: partial writes must be idempotent under retry (seen in cycle ${i})
    return { ok: true, data: out, etag: hash(out) };
  }
}`.repeat(2);
}
function testBlob(i: number): string {
  return `$ bun test module_${i}.test.ts
✓ handle returns data for valid id (${i}ms)
✗ handle is idempotent under retry (${i}ms)
  expected single write, observed 2 writes
  at module_${i}.test.ts:${30 + i}:11
 1 fail, 4 pass`.repeat(2);
}

export function buildScaled(cycles: number): CanonicalState {
  const turns: Turn[] = [
    { kind: "user_text", text: "Audit the service modules for idempotency bugs and fix each one you find." },
  ];
  const facts: Fact[] = [
    { id: "f0", text: "Task spans many service modules; each may have a retry-idempotency bug.", provenance: "user", valid: true },
  ];
  for (let i = 1; i <= cycles; i++) {
    turns.push({ kind: "assistant_text", text: `Investigating module_${i}.` });
    turns.push({ kind: "thinking", text: `Need to read module_${i} and run its tests to confirm the retry path.` });
    turns.push({ kind: "assistant_tool_call", callId: `r${i}`, name: "read_file", args: { path: `src/module_${i}.ts` } });
    turns.push({ kind: "tool_result", callId: `r${i}`, name: "read_file", result: fileBlob(i) });
    turns.push({ kind: "assistant_tool_call", callId: `t${i}`, name: "run_tests", args: { file: `module_${i}.test.ts` } });
    turns.push({ kind: "tool_result", callId: `t${i}`, name: "run_tests", result: testBlob(i) });
    turns.push({ kind: "assistant_text", text: `module_${i}: retry writes twice; wrap in idempotency guard.` });
    // each cycle yields ONE durable fact (ledger grows slowly vs transcript)
    facts.push({ id: `f${i}`, text: `module_${i}: handle() not idempotent under retry; guard with etag check.`, provenance: `run_tests module_${i}`, valid: true });
  }
  return {
    system: "You are a coding agent auditing a TS repo for idempotency bugs. Verify with tests.",
    openTask: "Fix retry-idempotency bugs across all service modules.",
    tools: [
      { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      { name: "run_tests", description: "Run tests", parameters: { type: "object", properties: { file: { type: "string" } }, required: ["file"] } },
      { name: "edit_file", description: "Edit a file", parameters: { type: "object", properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" } }, required: ["path", "find", "replace"] } },
    ],
    facts,
    turns,
  };
}
