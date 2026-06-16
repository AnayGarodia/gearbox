// Pure plan-fanout planner: lay tasks into waves that respect dependencies and
// keep same-file tasks out of the same wave.
import { test, expect } from "bun:test";
import { partitionIntoWaves } from "../src/agent/fanout.ts";

test("fully independent, disjoint-file tasks run in a single wave", () => {
  expect(partitionIntoWaves([{ files: ["a.ts"] }, { files: ["b.ts"] }, { files: ["c.ts"] }])).toEqual([[0, 1, 2]]);
  // no files at all → still one wave
  expect(partitionIntoWaves([{}, {}])).toEqual([[0, 1]]);
});

test("two tasks touching the same file are split into different waves", () => {
  const waves = partitionIntoWaves([{ files: ["shared.ts"] }, { files: ["shared.ts"] }, { files: ["other.ts"] }]);
  // task 0 and task 2 are disjoint → first wave; task 1 conflicts with 0 → second.
  expect(waves).toEqual([[0, 2], [1]]);
});

test("dependencies force topological ordering across waves", () => {
  // 0 ← 1 ← 2 (a chain): three waves, one each.
  expect(partitionIntoWaves([{}, { after: [0] }, { after: [1] }])).toEqual([[0], [1], [2]]);
  // a fan-in: 2 depends on both 0 and 1 (independent) → [0,1] then [2].
  expect(partitionIntoWaves([{}, {}, { after: [0, 1] }])).toEqual([[0, 1], [2]]);
});

test("deps and file conflicts compose", () => {
  // 0,1 independent but share a file → different waves; 2 depends on both.
  const waves = partitionIntoWaves([{ files: ["x.ts"] }, { files: ["x.ts"] }, { after: [0, 1] }]);
  expect(waves[0]).toEqual([0]);
  expect(waves[1]).toEqual([1]);
  expect(waves[2]).toEqual([2]); // only after BOTH 0 and 1 placed
});

test("a dependency cycle terminates (best-effort), never hangs", () => {
  // 0↔1 cycle: neither is ever 'ready', so they're emitted together as a wave.
  const waves = partitionIntoWaves([{ after: [1] }, { after: [0] }]);
  expect(waves.flat().sort()).toEqual([0, 1]);
});

test("out-of-range and self dependencies are ignored", () => {
  expect(partitionIntoWaves([{ after: [0, 5, -1] }, { after: [99] }])).toEqual([[0, 1]]);
});

test("empty input → no waves; every index appears exactly once", () => {
  expect(partitionIntoWaves([])).toEqual([]);
  const waves = partitionIntoWaves([{ files: ["a"] }, { files: ["a"] }, { files: ["a"] }, { after: [0] }]);
  expect(waves.flat().sort((x, y) => x - y)).toEqual([0, 1, 2, 3]);
});
