// Pure difficulty estimator: difficulty WITHIN a kind, from non-LLM context
// signals. "fix it" is the same kind (code) whether it's a hello-world or a
// DB-pool race; this estimates which, so the router can raise the bar without a
// model call. All signals optional; absent = neutral (no penalty for unknowns).
import { test, expect } from "bun:test";
import { estimateDifficulty, DIFFICULTY_BAR_RANGE } from "../src/model/difficulty.ts";

test("no signals → zero difficulty, no reasons", () => {
  const r = estimateDifficulty({});
  expect(r.d).toBe(0);
  expect(r.reasons).toEqual([]);
});

test("large working set raises difficulty", () => {
  expect(estimateDifficulty({ estTokens: 10_000 }).d).toBe(0); // below the floor
  expect(estimateDifficulty({ estTokens: 120_000 }).d).toBeGreaterThan(0.25);
});

test("more touched files → monotonically harder", () => {
  const one = estimateDifficulty({ touchedFileCount: 1 }).d;
  const few = estimateDifficulty({ touchedFileCount: 3 }).d;
  const many = estimateDifficulty({ touchedFileCount: 8 }).d;
  expect(one).toBe(0);
  expect(few).toBeGreaterThan(one);
  expect(many).toBeGreaterThan(few);
});

test("a repo where code keeps failing raises difficulty", () => {
  expect(estimateDifficulty({ repoFailRate: 0 }).d).toBe(0);
  expect(estimateDifficulty({ repoFailRate: 0.5 }).d).toBeGreaterThan(0.1);
});

test("no test net adds a conservative bump; a net does not; unknown is neutral", () => {
  expect(estimateDifficulty({ hasTestNet: false }).d).toBeGreaterThan(0);
  expect(estimateDifficulty({ hasTestNet: true }).d).toBe(0);
  expect(estimateDifficulty({}).d).toBe(0); // undefined net is neutral
});

test("central code (high fan-in) raises difficulty", () => {
  expect(estimateDifficulty({ centrality: 1 }).d).toBeGreaterThan(0.1);
});

test("signals compound and clamp to [0,1] with readable reasons", () => {
  const hard = estimateDifficulty({
    estTokens: 120_000, touchedFileCount: 8, touchedBytes: 100_000, repoFailRate: 0.5, hasTestNet: false,
  });
  expect(hard.d).toBeGreaterThan(0.6);
  expect(hard.d).toBeLessThanOrEqual(1);
  expect(hard.reasons.length).toBeGreaterThan(1);

  const extreme = estimateDifficulty({
    estTokens: 1_000_000, touchedFileCount: 100, touchedBytes: 1_000_000, repoFailRate: 1, centrality: 1, hasTestNet: false,
  });
  expect(extreme.d).toBe(1);
});

test("DIFFICULTY_BAR_RANGE keeps a code task (0.7) within the strong tier (≤0.9)", () => {
  expect(0.7 + 1 * DIFFICULTY_BAR_RANGE).toBeCloseTo(0.9, 5);
});

// ── Lexical difficulty: a semantic read of the PROMPT (pure, instant, no LLM). ──
// "fix the race condition in the connection pool" is hard; "fix the typo" is easy;
// "fix it" is genuinely ambiguous (null → fall back to size signals). This is the
// signal the size-based estimator is blind to: a bare prompt with no @files and a
// small context still has a difficulty the WORDS reveal.
import { lexicalDifficulty, BAND_SCORE } from "../src/model/difficulty.ts";

test("lexicalDifficulty flags obvious-hard prompts", () => {
  expect(lexicalDifficulty("fix the race condition in the connection pool")).toBe("hard");
  expect(lexicalDifficulty("refactor authentication across all services")).toBe("hard");
  expect(lexicalDifficulty("debug the deadlock in the scheduler")).toBe("hard");
  expect(lexicalDifficulty("rewrite the migration to be idempotent")).toBe("hard");
});

test("lexicalDifficulty flags obvious-trivial prompts", () => {
  expect(lexicalDifficulty("fix the typo in the readme")).toBe("easy");
  expect(lexicalDifficulty("rename getUser to fetchUser")).toBe("easy");
  expect(lexicalDifficulty("bump the version to 0.23.0")).toBe("easy");
});

test("lexicalDifficulty returns null when the prompt reveals nothing", () => {
  expect(lexicalDifficulty("fix it")).toBe(null);
  expect(lexicalDifficulty("update the handler")).toBe(null);
});

test("a hard prompt-band lifts difficulty even with NO size signals", () => {
  const bare = estimateDifficulty({});
  const hardWords = estimateDifficulty({ semanticBand: "hard" });
  expect(bare.d).toBe(0);
  expect(hardWords.d).toBe(BAND_SCORE.hard);
  expect(hardWords.d).toBeGreaterThan(0.6);
});

test("an easy band never drags a genuinely large task back down (max-combine)", () => {
  const big = estimateDifficulty({ estTokens: 120_000, touchedFileCount: 8 });
  const bigButEasyWords = estimateDifficulty({ estTokens: 120_000, touchedFileCount: 8, semanticBand: "easy" });
  expect(bigButEasyWords.d).toBe(big.d); // max(sizeBased, easy=0) = sizeBased
});
