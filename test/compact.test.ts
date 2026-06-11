// The compaction escalation ladder: the trigger is token-based but the old
// executors were turn-count-gated (`split < 1 → null`), so one mega-turn could
// fill the window while /compact said "nothing old enough" forever. These tests
// pin the ladder: lower keepRecent → elide inside the window → truncate
// oversized tool results in place — and null ONLY when genuinely small.
import { test, expect } from "bun:test";
import type { ModelMessage } from "ai";
import { compactHistory, elideHistory, truncateToolResults, estimateHistoryTokens, type Summarizer } from "../src/context/compact.ts";

const fakeSummary: Summarizer = async (transcript) => `SUMMARY(${transcript.length} chars)`;
const boom: Summarizer = async () => {
  throw new Error("summarizer must not be called");
};

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

function toolTurn(n: number, body = "file body ".repeat(50)): ModelMessage[] {
  const id = `t${n}`;
  return [
    { role: "user", content: `do task ${n}` },
    { role: "assistant", content: [{ type: "text", text: `working on ${n}` }, { type: "tool-call", toolCallId: id, toolName: "read_file", input: { path: "x.ts" } }] as any },
    { role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "read_file", output: { type: "text", value: body } }] as any },
    { role: "assistant", content: [{ type: "text", text: `done ${n}` }] as any },
  ];
}

// ── rung 1: the ladder lowers keepRecent until something is old enough ──

test("elideHistory lowers keepRecent when nothing is old enough at the requested one", () => {
  // 2 turns, keepRecent 4 — the old gate returned null here.
  const res = elideHistory([...toolTurn(1), ...toolTurn(2)], 4);
  expect(res).not.toBeNull();
  expect(res!.summarizedTurns).toBe(1); // lowered to keepRecent=1 → 1 old turn elided
  expect(res!.how).toBe("elided 1 turn");
  expect(res!.after).toBeLessThan(res!.before);
  const { calls } = toolIds(res!.messages);
  expect(calls.has("t2")).toBe(true); // most recent kept whole
  expect(calls.has("t1")).toBe(false);
});

test("compactHistory lowers keepRecent when nothing is old enough at the requested one", async () => {
  const res = await compactHistory({ history: [...toolTurn(1), ...toolTurn(2)], summarize: fakeSummary, keepRecent: 4 });
  expect(res).not.toBeNull();
  expect(res!.summarizedTurns).toBe(1);
  expect(res!.how).toBe("summarized 1 turn");
  const { calls, results } = toolIds(res!.messages);
  expect([...calls].sort()).toEqual([...results].sort()); // pairing invariant
  expect(calls.has("t2")).toBe(true);
});

test("compactHistory carries focus instruction and reversible archive pointer", async () => {
  let seen = "";
  const summarize: Summarizer = async (transcript) => {
    seen = transcript;
    return JSON.stringify({
      goals: ["keep authentication facts"],
      decisions: [],
      files: [{ path: "x.ts", change: "read during compacted turns" }],
      commands: [],
      facts: ["authentication facts were preserved"],
      openThreads: [],
      topics: [{ title: "authentication", notes: ["token work"], files: ["x.ts"] }],
    });
  };
  const res = await compactHistory({
    history: [...toolTurn(1), ...toolTurn(2), ...toolTurn(3)],
    summarize,
    keepRecent: 1,
    focusInstruction: "authentication flow",
    archiveId: "compact-test",
  });
  expect(res).not.toBeNull();
  expect(seen).toContain("Compaction focus: preserve details relevant to \"authentication flow\"");
  expect(JSON.stringify(res!.messages)).toContain("compaction archive: compact-test");
  expect(res!.archive?.id).toBe("compact-test");
  expect(res!.archive?.instruction).toBe("authentication flow");
  expect(res!.archive?.turns).toEqual({ start: 1, end: 2 });
  expect(res!.archive?.messages.length).toBe(toolTurn(1).length + toolTurn(2).length);
  expect(res!.archive?.structured?.goals).toEqual(["keep authentication facts"]);
  expect(res!.archive?.verification?.ok).toBe(true);
});

// ── final rung: a single mega-turn shrinks via in-place tool-result truncation ──

test("a single mega-turn actually shrinks (truncated tool result, honest `how`)", () => {
  const history = toolTurn(1, "chunk of output ".repeat(3200)); // one 50k-char tool result, one turn
  const res = elideHistory(history, 4);
  expect(res).not.toBeNull();
  expect(res!.how).toBe("truncated 1 oversized tool result");
  expect(res!.after).toBeLessThan(res!.before);
  const text = JSON.stringify(res!.messages);
  expect(text).toContain("[output truncated during compaction — re-read the file if needed]");
  // tool ids stay PAIRED — truncation edits content in place, never drops a side
  const { calls, results } = toolIds(res!.messages);
  expect([...calls].sort()).toEqual([...results].sort());
  expect(calls.has("t1")).toBe(true);
});

test("compactHistory reaches the truncation rung without calling the summarizer", async () => {
  const history = toolTurn(1, "chunk of output ".repeat(3200));
  const res = await compactHistory({ history, summarize: boom, keepRecent: 4 }); // boom throws if called
  expect(res).not.toBeNull();
  expect(res!.how).toContain("truncated");
  expect(res!.after).toBeLessThan(res!.before);
});

test("intra-window rung elides every kept turn except the last when only the preamble gate blocked", () => {
  // Two turns where eliding only the FIRST (the k=1 ladder rung with its
  // preamble overhead) wouldn't save: tiny tool bodies, so the rungs cascade.
  // With normal bodies the ladder fires first — this pins the cascade order
  // indirectly: the result is whichever rung first SAVES tokens.
  const res = elideHistory([...toolTurn(1), ...toolTurn(2, "more tool output ".repeat(1300))], 4)!;
  expect(res).not.toBeNull();
  expect(res.after).toBeLessThan(res.before);
});

// ── preambles never stack ──

test("repeated elideHistory reuses the preamble instead of stacking a second", () => {
  const first = elideHistory([...toolTurn(1), ...toolTurn(2), ...toolTurn(3), ...toolTurn(4)], 1)!;
  expect(first).not.toBeNull();
  const grown = [...first.messages, ...toolTurn(5)];
  const second = elideHistory(grown, 1)!;
  expect(second).not.toBeNull();
  const sentinels = second.messages.filter((m) => m.role === "user" && m.content === "Compact the earlier conversation.");
  expect(sentinels.length).toBe(1); // exactly one preamble, not two
  expect(second.messages[0]!.role).toBe("user"); // and it leads the history
  const { calls, results } = toolIds(second.messages);
  expect([...calls].sort()).toEqual([...results].sort());
  expect(calls.has("t5")).toBe(true); // newest turn kept whole
});

// ── null ONLY when genuinely small ──

test("null only when the history is genuinely small (no rung saves anything)", async () => {
  const small = [...toolTurn(1)]; // one turn, tiny tool result
  expect(elideHistory(small, 4)).toBeNull();
  expect(await compactHistory({ history: small, summarize: boom, keepRecent: 4 })).toBeNull();
  const tiny: ModelMessage[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ];
  expect(elideHistory(tiny, 4)).toBeNull();
});

// ── truncateToolResults: the pure final-rung primitive ──

test("truncateToolResults caps only oversized results and counts them", () => {
  const messages: ModelMessage[] = [
    ...toolTurn(1, "big tool output ".repeat(2600)),
    ...toolTurn(2, "small body"),
  ];
  const { messages: out, truncated } = truncateToolResults(messages, 2000);
  expect(truncated).toBe(1);
  const text = JSON.stringify(out);
  expect(text).toContain("[output truncated during compaction — re-read the file if needed]");
  expect(text).toContain("small body"); // under-cap result untouched
  expect(estimateHistoryTokens(out)).toBeLessThan(estimateHistoryTokens(messages));
  const { calls, results } = toolIds(out);
  expect([...calls].sort()).toEqual([...results].sort());
  // a fully-small history passes through with zero truncations
  expect(truncateToolResults([...toolTurn(3)], 2000).truncated).toBe(0);
});

// ── THE FULL LOOP: compact → archive → a later prompt recalls it ─────────────
// The integration seam none of the unit tests covered: a real compactHistory
// result's archive, fed back through buildContext, must resurface when a
// future prompt resembles the archived work — and stay silent when it doesn't.
test("a compaction archive is recalled by a later related prompt (end to end)", async () => {
  const { buildContext } = await import("../src/context/builder.ts");
  const { findModel } = await import("../src/providers.ts");
  const sonnet = findModel("sonnet-4.6")!;
  const history: ModelMessage[] = [
    { role: "user", content: "fix the oauth refresh rotation bug in src/accounts/health.ts" },
    // padded so the summary is genuinely SMALLER than the turns it replaces
    // (compactHistory falls back to mechanical elision otherwise — no archive)
    { role: "assistant", content: "Edited src/accounts/health.ts to re-read auth before refresh. Ran bun test test/health.test.ts — passed. " + "Investigated the refresh flow in detail. ".repeat(200) },
    { role: "user", content: "now the unrelated thing" },
    { role: "assistant", content: "done" },
  ];
  const summarize: Summarizer = async () => JSON.stringify({
    goals: ["fix oauth refresh rotation"],
    decisions: [],
    files: [{ path: "src/accounts/health.ts", change: "re-read auth before refresh" }],
    commands: [{ command: "bun test test/health.test.ts", outcome: "passed" }],
    facts: [], openThreads: [],
    topics: [{ title: "oauth refresh rotation", notes: ["refresh tokens are single-use"], files: ["src/accounts/health.ts"] }],
  });
  const res = await compactHistory({ history, summarize, keepRecent: 1, archiveId: "arc-oauth" });
  expect(res?.archive).toBeTruthy();
  expect(res!.archive!.summary).toContain("src/accounts/health.ts"); // anchor survived (verified)

  // A related later prompt recalls the archive…
  const recalled = buildContext({ history: [], userText: "continue the oauth refresh rotation work", model: sonnet, compactions: [{ ...res!.archive!, at: 1 } as any] });
  const text = JSON.stringify(recalled.messages[recalled.messages.length - 1]!.content);
  expect(text).toContain("RELEVANT ARCHIVED CONTEXT");
  expect(text).toContain("arc-oauth");
  // …an unrelated prompt does not.
  const quiet = buildContext({ history: [], userText: "what color should the mascot be", model: sonnet, compactions: [{ ...res!.archive!, at: 1 } as any] });
  expect(JSON.stringify(quiet.messages[quiet.messages.length - 1]!.content)).not.toContain("RELEVANT ARCHIVED CONTEXT");
});
