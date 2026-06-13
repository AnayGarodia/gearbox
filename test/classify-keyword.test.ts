// TDD fixture for the FREE keyword task-judge (src/model/router.ts classify).
// The corpus lives in experiments/routing/classify-corpus.ts (shared with the
// T1 bench). Two guarantees:
//   1. SAFETY (the one that matters): no prompt is ever routed BELOW its bar —
//      a hard task (code/plan) must never land on a cheaper kind. Asserted for
//      every row, including the genuinely-ambiguous `floor` ones.
//   2. PRECISION: on unambiguous rows, the exact kind is returned. `floor` rows
//      are exempt (their exact label is judgement-call; only safety is required).
import { test, expect } from "bun:test";
import { classify } from "../src/model/router.ts";
import { CORPUS, BAR, type Kind } from "../experiments/routing/classify-corpus.ts";

test("keyword judge never routes a hard task below its bar (no dangerous misroutes)", () => {
  const dangerous = CORPUS.filter((c) => BAR[classify(c.prompt) as Kind] < BAR[c.expected]).map(
    (c) => `[${c.expected}→${classify(c.prompt)}] ${c.prompt}`,
  );
  expect(dangerous).toEqual([]);
});

test("keyword judge returns the exact kind on unambiguous prompts", () => {
  const wrong = CORPUS.filter((c) => !c.floor && classify(c.prompt) !== c.expected).map(
    (c) => `[want ${c.expected}, got ${classify(c.prompt)}] ${c.prompt}`,
  );
  expect(wrong).toEqual([]);
});
