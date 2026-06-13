// Failure-kind-aware escalation + verifier-tier caution (routing-bench-validated
// ideas, built onto the live engine). Asserted via the /why scorecard's `bar`,
// so the tests are deterministic regardless of which accounts are configured.
//
//   - A TEST failure is a reasoning miss → climb hard toward the top tier.
//   - A MECHANICAL failure (typecheck/lint/build — the compiler pinpointed the
//     exact error) is an easy fix → barely raise the bar; a cheap model handles it.
//   - NO verifier net → a cheap miss is invisible → raise the bar (be cautious);
//     a present net → cheap-first is safe, no extra caution.
import { test, expect } from "bun:test";
import { RoutingSelector } from "../src/model/router.ts";

const bar = (t: Parameters<RoutingSelector["explain"]>[0]) => new RoutingSelector().explain(t).bar;

test("a test failure escalates HARDER than a mechanical (typecheck) failure", () => {
  const t = { prompt: "fix the parser", kind: "code" as const, escalate: 1 };
  const testFail = bar({ ...t, failureKind: "test" });
  const typeFail = bar({ ...t, failureKind: "typecheck" });
  expect(testFail).toBeGreaterThan(typeFail);
});

test("a mechanical failure barely raises the bar (cheap model can fix a pinpointed error)", () => {
  const base = bar({ prompt: "fix the parser", kind: "code" });
  const typeFail = bar({ prompt: "fix the parser", kind: "code", escalate: 1, failureKind: "typecheck" });
  // It rises (it did miss once) but stays well below a test failure's jump.
  expect(typeFail).toBeGreaterThanOrEqual(base);
  expect(typeFail - base).toBeLessThan(0.08);
});

test("a test failure at escalate 1 lifts the bar into the top tier", () => {
  const testFail = bar({ prompt: "fix the parser", kind: "code", escalate: 1, failureKind: "test" });
  expect(testFail).toBeGreaterThanOrEqual(0.85);
});

test("no verifier net raises the bar above a repo that has tests (same code task)", () => {
  const withNet = bar({ prompt: "add a helper", kind: "code", verifierTier: "tests" });
  const noNet = bar({ prompt: "add a helper", kind: "code", verifierTier: "none" });
  expect(noNet).toBeGreaterThan(withNet);
});

test("verifier tier never lifts a cheap kind off its low bar", () => {
  const withNet = bar({ prompt: "what is a closure", kind: "chat", verifierTier: "tests" });
  const noNet = bar({ prompt: "what is a closure", kind: "chat", verifierTier: "none" });
  expect(noNet).toBe(withNet);
});

test("kind-blind escalation (no failureKind) still works — back-compat", () => {
  const base = bar({ prompt: "fix the parser", kind: "code" });
  const esc = bar({ prompt: "fix the parser", kind: "code", escalate: 2 });
  expect(esc).toBeGreaterThan(base);
});
