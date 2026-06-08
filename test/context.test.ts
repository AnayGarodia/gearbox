import { test, expect, afterAll } from "bun:test";
import type { ModelMessage } from "ai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countTokens, baseTokens } from "../src/model/tokens.ts";
import { buildContext, sanitizeToolPairs } from "../src/context/builder.ts";
import { repoMap } from "../src/context/repomap.ts";
import { rankFiles, retrieveFiles, resetRetrievalIndex } from "../src/context/retrieve.ts";
import { appendFact, loadFacts } from "../src/context/memory.ts";
import { compactHistory, estimateHistoryTokens, type Summarizer } from "../src/context/compact.ts";
import { findModel, type ModelSpec } from "../src/providers.ts";

const sonnet = findModel("sonnet-4.6")!;

// ── tokenizer: calibration is real, model-aware, and never under tiktoken ──
test("countTokens applies measured per-model calibration", () => {
  const text = "export function debounce(fn: () => void, ms: number) { /* ... */ }".repeat(8);
  const base = baseTokens(text);
  expect(base).toBeGreaterThan(0);

  const claude = countTokens(text, "claude-sonnet-4-6"); // calibration 1.35
  const openai = countTokens(text, "gpt-5.5"); // calibration 1.0

  expect(claude).toBeGreaterThan(base); // Claude runs hotter than tiktoken
  expect(openai).toBe(base); // tiktoken-native → no scaling
  // unknown model falls back to the safe over-estimate (>= base)
  expect(countTokens(text)).toBeGreaterThanOrEqual(base);
});

// ── repo map: structural awareness, real signatures ──
test("repoMap emits file paths and signatures within budget", () => {
  const map = repoMap(process.cwd(), 4000);
  expect(map.length).toBeGreaterThan(0);
  expect(map).toContain("src/"); // paths present
  expect(map).toMatch(/class|function|interface|const/); // signatures present
  expect(countTokens(map)).toBeLessThanOrEqual(4000 + 200); // budget honored (±one block)
});

// ── retrieval: BM25 surfaces the right file for a behavior-described query ──
test("rankFiles surfaces the model-selection files for a routing query", () => {
  resetRetrievalIndex();
  const ranked = rankFiles("change which model is used by default", process.cwd());
  expect(ranked.length).toBeGreaterThan(0);
  const top5 = ranked.slice(0, 5).map((r) => r.file);
  expect(top5.some((f) => f.includes("selector") || f.includes("config"))).toBe(true);
});

test("retrieveFiles packs file bodies within the token budget", () => {
  const hits = retrieveFiles("how does the agent stream events", process.cwd(), 6, 6000);
  const total = hits.reduce((s, h) => s + h.tokens, 0);
  expect(total).toBeLessThanOrEqual(6000);
  for (const h of hits) expect(h.content.length).toBeGreaterThan(0);
});

// ── builder: assembly order, current user always last ──
test("buildContext puts memory/repomap in system and ends with the user message", () => {
  const { system, messages } = buildContext({
    history: [],
    userText: "fix the off-by-one in the pager",
    model: sonnet,
  });
  expect(system).toContain("Gearbox"); // base prompt
  const last = messages[messages.length - 1]!;
  expect(last.role).toBe("user");
  expect(last.content).toBe("fix the off-by-one in the pager");
});

test("plan mode injects the read-only addendum", () => {
  const { system } = buildContext({ history: [], userText: "x", model: sonnet, plan: true });
  expect(system).toContain("PLAN MODE");
});

// The model should learn the project's real check commands up front (cache-stable),
// not discover the bar by failing post-turn. cwd here is the gearbox repo, which
// has typecheck/test/build scripts.
test("buildContext injects the project's verification commands into the system prefix", () => {
  const { system, sections } = buildContext({ history: [], userText: "add a feature", model: sonnet });
  expect(system).toContain("VERIFICATION COMMANDS");
  expect(system).toMatch(/typecheck|test/);
  expect(sections.some((s) => s.name === "verify")).toBe(true);
});

// ── THE INVARIANT: curation never splits a tool_use from its tool_result ──
function toolIds(messages: ModelMessage[]): { calls: Set<string>; results: Set<string> } {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const m of messages) {
    const content = (m as any).content;
    if (!Array.isArray(content)) continue;
    for (const p of content) {
      if (p?.type === "tool-call") calls.add(p.toolCallId);
      if (p?.type === "tool-result") results.add(p.toolCallId);
    }
  }
  return { calls, results };
}

// A turn that uses a tool: assistant calls it, a tool message returns the result.
function toolTurn(n: number): ModelMessage[] {
  const id = `t${n}`;
  return [
    { role: "user", content: `do task ${n}` },
    { role: "assistant", content: [{ type: "text", text: `working on ${n}` }, { type: "tool-call", toolCallId: id, toolName: "read_file", input: { path: "x.ts" } }] as any },
    { role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "read_file", output: { type: "text", value: "file body ".repeat(50) } }] as any },
    { role: "assistant", content: [{ type: "text", text: `done ${n}` }] as any },
  ];
}

test("recent turns keep tool_use/tool_result paired", () => {
  const history = [...toolTurn(1), ...toolTurn(2)];
  const { messages } = buildContext({ history, userText: "next", model: sonnet, recentTurns: 5 });
  const { calls, results } = toolIds(messages);
  expect(calls.size).toBeGreaterThan(0);
  expect([...calls].sort()).toEqual([...results].sort()); // every call has its result
});

test("eliding old turns drops BOTH sides of the tool exchange (balanced ids)", () => {
  const history = [...toolTurn(1), ...toolTurn(2), ...toolTurn(3)];
  // recentTurns:0 forces every turn through elision → no tool IO should survive,
  // and crucially no orphaned tool-call or tool-result.
  const { messages } = buildContext({ history, userText: "next", model: sonnet, recentTurns: 0 });
  const { calls, results } = toolIds(messages);
  expect(calls.size).toBe(0);
  expect(results.size).toBe(0);
  // user text from old turns is preserved (the conversational gist stays)
  expect(messages.some((m) => m.role === "user" && m.content === "do task 1")).toBe(true);
});

test("buildContext trims oldest whole turns when over budget", () => {
  // Tiny window → 8k input floor. Many large turns must get trimmed.
  const tiny: ModelSpec = { ...sonnet, contextWindow: 40_000 };
  const big = "lorem ipsum dolor sit amet ".repeat(400); // ~well over budget across turns
  const history: ModelMessage[] = [];
  for (let i = 0; i < 12; i++) {
    history.push({ role: "user", content: `${big} turn ${i}` });
    history.push({ role: "assistant", content: `reply ${i}` });
  }
  const { messages } = buildContext({ history, userText: "final", model: tiny, recentTurns: 99 });
  // Not everything fit → some turns dropped, but the current user message survives.
  expect(messages.length).toBeLessThan(history.length + 1);
  expect(messages[messages.length - 1]!.content).toBe("final");
});

// ── project memory: append/load round-trip (isolated GEARBOX_HOME) ──
test("appendFact then loadFacts round-trips", () => {
  const home = mkdtempSync(join(tmpdir(), "gearbox-mem-"));
  const prev = process.env.GEARBOX_HOME;
  process.env.GEARBOX_HOME = home;
  try {
    expect(loadFacts()).toBe("");
    expect(appendFact("the pager uses 0-based line indices")).toBe(true);
    expect(loadFacts()).toContain("0-based line indices");
    expect(appendFact("   ")).toBe(false); // blank rejected
  } finally {
    if (prev === undefined) delete process.env.GEARBOX_HOME;
    else process.env.GEARBOX_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

// ── interrupted-turn safety: dangling tool_use must never reach the API ──
test("sanitizeToolPairs drops a tool_use whose result never arrived", () => {
  const interrupted: ModelMessage[] = [
    { role: "user", content: "do it" },
    { role: "assistant", content: [{ type: "text", text: "calling" }, { type: "tool-call", toolCallId: "x1", toolName: "read_file", input: {} }] as any },
    // ...interrupted here: no tool-result for x1
  ];
  const clean = sanitizeToolPairs(interrupted);
  const { calls, results } = toolIds(clean);
  expect(calls.size).toBe(0); // unpaired call removed
  expect(results.size).toBe(0);
  // the assistant text survives, the message isn't dropped wholesale
  expect(clean.some((m) => m.role === "assistant")).toBe(true);
  expect(sanitizeToolPairs(interrupted).length).toBeGreaterThan(0);
});

test("sanitizeToolPairs drops an orphan tool_result and is idempotent on balanced input", () => {
  const orphan: ModelMessage[] = [
    { role: "user", content: "hi" },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "ghost", toolName: "x", output: { type: "text", value: "?" } }] as any },
  ];
  const { results } = toolIds(sanitizeToolPairs(orphan));
  expect(results.size).toBe(0);

  const balanced = [...toolTurn(1)];
  expect(sanitizeToolPairs(balanced).length).toBe(balanced.length); // unchanged
});

test("buildContext sanitizes a history that ends mid-tool-call (interrupted turn)", () => {
  const history: ModelMessage[] = [
    ...toolTurn(1),
    { role: "user", content: "another" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "dangling", toolName: "read_file", input: {} }] as any },
  ];
  const { messages } = buildContext({ history, userText: "next", model: sonnet, recentTurns: 5 });
  const { calls, results } = toolIds(messages);
  expect([...calls].sort()).toEqual([...results].sort()); // balanced → valid send
  expect(calls.has("dangling")).toBe(false);
});

// ── auto-compaction ──
const fakeSummary: Summarizer = async (transcript) => `SUMMARY(${transcript.length} chars): goals + files + open threads`;

test("compactHistory summarizes old turns, keeps recent verbatim, stays balanced", async () => {
  const history = [...toolTurn(1), ...toolTurn(2), ...toolTurn(3), ...toolTurn(4)];
  const res = await compactHistory({ history, summarize: fakeSummary, keepRecent: 1 });
  expect(res).not.toBeNull();
  expect(res!.summarizedTurns).toBe(3); // 4 turns, kept 1
  // synthetic summary exchange leads, then the kept recent turn
  expect(res!.messages[0]!.role).toBe("user");
  expect(res!.messages[1]!.role).toBe("assistant");
  expect(String((res!.messages[1] as any).content)).toContain("SUMMARY");
  // the kept recent turn (turn 4) survives whole, with its tool pair intact
  const { calls, results } = toolIds(res!.messages);
  expect([...calls].sort()).toEqual([...results].sort());
  expect(calls.has("t4")).toBe(true); // recent kept
  expect(calls.has("t1")).toBe(false); // old summarized away
  // compaction shrinks the working set
  expect(res!.after).toBeLessThan(res!.before);
});

test("compacted history feeds buildContext into a valid send (the integration seam)", async () => {
  // compact → rewrite msgRef → next buildContext must produce a valid working
  // set: ends with the user message AND tool ids stay balanced (no 400).
  const res = await compactHistory({ history: [...toolTurn(1), ...toolTurn(2), ...toolTurn(3)], summarize: fakeSummary, keepRecent: 1 });
  expect(res).not.toBeNull();
  const { messages } = buildContext({ history: res!.messages, userText: "next", model: sonnet });
  expect(messages[messages.length - 1]!.role).toBe("user");
  expect(messages[messages.length - 1]!.content).toBe("next");
  const { calls, results } = toolIds(messages);
  expect([...calls].sort()).toEqual([...results].sort());
});

test("compactHistory returns null when nothing is old enough", async () => {
  const history = [...toolTurn(1)];
  expect(await compactHistory({ history, summarize: fakeSummary, keepRecent: 4 })).toBeNull();
});

test("compactHistory keeps original history when the summarizer fails", async () => {
  const history = [...toolTurn(1), ...toolTurn(2), ...toolTurn(3)];
  const boom: Summarizer = async () => {
    throw new Error("model down");
  };
  expect(await compactHistory({ history, summarize: boom, keepRecent: 1 })).toBeNull();
});

test("estimateHistoryTokens grows with history", () => {
  const a = estimateHistoryTokens([...toolTurn(1)]);
  const b = estimateHistoryTokens([...toolTurn(1), ...toolTurn(2)]);
  expect(b).toBeGreaterThan(a);
});

afterAll(() => resetRetrievalIndex());
