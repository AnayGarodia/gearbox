// The difficulty axis wired into the router: the SAME code prompt routes to a
// higher bar when the context says it's hard (big working set, many files), and
// cheap kinds are never touched. Asserted via the /why scorecard's `bar`, so the
// test is deterministic regardless of which accounts are configured.
import { test, expect } from "bun:test";
import { RoutingSelector } from "../src/model/router.ts";

test("a heavy code task raises the bar above the bare-prompt baseline (context, not words)", () => {
  const r = new RoutingSelector();
  const base = r.explain({ prompt: "refactor the parser", kind: "code" }).bar;
  const hard = r.explain({
    prompt: "refactor the parser",
    kind: "code",
    estTokens: 400_000,
    touchedFiles: Array.from({ length: 30 }, (_, i) => `module-${i}.ts`),
  }).bar;
  expect(hard).toBeGreaterThan(base);
  expect(hard).toBeLessThanOrEqual(0.95);
});

test("difficulty never touches cheap kinds — chat stays at its low bar even with heavy signals", () => {
  const r = new RoutingSelector();
  const base = r.explain({ prompt: "what is a closure", kind: "chat" }).bar;
  const withSignals = r.explain({
    prompt: "what is a closure",
    kind: "chat",
    estTokens: 400_000,
    touchedFiles: Array.from({ length: 30 }, (_, i) => `m-${i}.ts`),
  }).bar;
  expect(withSignals).toBe(base);
});
