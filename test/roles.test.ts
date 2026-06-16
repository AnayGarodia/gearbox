// Delegation roles → routing signals. Pure module, so this fully covers it.
import { test, expect } from "bun:test";
import { ROLES, roleByName, roleRoutingSignals, READ_ONLY_TOOLS } from "../src/agent/roles.ts";

test("the role table carries the posture each archetype implies", () => {
  // explore: read-only, search-kind, cheap/fast, no writes.
  expect(ROLES.explore.readOnly).toBe(true);
  expect(ROLES.explore.kind).toBe("search");
  expect(ROLES.explore.tools).toEqual(READ_ONLY_TOOLS);
  expect(ROLES.explore.crossFamily).toBeFalsy();
  // review: read-only, code-kind (high bar), cross-family, high effort.
  expect(ROLES.review.readOnly).toBe(true);
  expect(ROLES.review.kind).toBe("code");
  expect(ROLES.review.crossFamily).toBe(true);
  expect(ROLES.review.effort).toBe("high");
  // code: the implementer — full tools, no read-only restriction.
  expect(ROLES.code.readOnly).toBeFalsy();
  expect(ROLES.code.tools).toBeUndefined();
});

test("roleByName is case-insensitive and undefined for unknowns", () => {
  expect(roleByName("REVIEW")).toBe(ROLES.review);
  expect(roleByName("explore")).toBe(ROLES.explore);
  expect(roleByName("nope")).toBeUndefined();
});

test("roleRoutingSignals: a cross-family reviewer excludes the author's vendor", () => {
  const sig = roleRoutingSignals(ROLES.review, "claude-opus-4-8");
  expect(sig.kind).toBe("code");
  expect(sig.excludeFamily).toContain("claude"); // route AWAY from claude to review claude's work
  // without an author model there is nothing to exclude (still a valid review).
  expect(roleRoutingSignals(ROLES.review).excludeFamily).toBeUndefined();
  // a non-cross-family role never excludes anyone.
  expect(roleRoutingSignals(ROLES.explore, "claude-opus-4-8").excludeFamily).toBeUndefined();
  expect(roleRoutingSignals(ROLES.code, "gpt-5.5-pro").excludeFamily).toBeUndefined();
});
